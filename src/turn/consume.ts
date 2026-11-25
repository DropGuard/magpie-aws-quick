// One Quick turn's event stream, interpreted.
//
// This used to be a closure (consume) inside the turn generator: ~150 lines of
// event dispatch, parser flushing, native-tool salvage and the pseudo-200 quota
// probe, entangled with the generator's own state. It is a state machine with
// one input (Quick events) and one output (normalized items), so it lives here.
// A fresh consumer is created per attempt: its parser, sources stripper and
// quota probe are all attempt-local by construction (the guardrail retry used
// to reset those by hand).
import { QuickWsError } from '../quickws.ts'
import { createToolCallParser, createSourcesStripper } from '../tools.ts'
import { INVALID_CALL_TOOL } from './prompts.ts'

/** Normalized turn output the HTTP layer renders. */
export type TurnItem =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: any }
  | { type: 'note'; text: string }

/** What the consumer accumulates for the turn's final report. */
export interface StreamState {
  text: string
  reasoning: string
  usage: any
  calls: { id: string; name: string }[]
}

/** Cross-attempt salvage bookkeeping, written into the session entry. */
export interface Salvage {
  /** Client-tool calls salvaged from Quick's native channel this turn. */
  salvageCalls: { name: string; arguments: string }[]
  /** A <tool_call> the model failed to finish — restated on the next turn. */
  droppedCall: { reason: string; name: string } | null
}

export interface ConsumeOptions {
  tools: any[]
  canonClientTool: (name: any) => string | null
  showQuickTools: boolean
}

export interface ConsumeHooks {
  /** The event is progress, not transport noise — bump the idle watchdog. */
  onProgress?: () => void
  /** Salvaged calls exist and the model step ended: stop the Quick turn. */
  onSalvageStop?: () => void
}

// Quota exhaustion can surface as a NORMAL assistant reply — no error frame,
// just this fixed sentence as the entire message (first reported by
// kuk-888/aws-quick2api). Passed through, the client sees the model suddenly
// talking nonsense mid-task; detected, magpie fails over to another account.
const PSEUDO200_PHRASES = [
  "you've reached your usage limit. check your profile for details.",
  'you have reached your usage limit. check your profile for details.',
]

// Quick's guardrail answers a turn with an error frame whose text is one of a
// few canned sentences (measured: every occurrence carries usage 0/0, so it is
// never model output). Server-side policy cannot be configured, but the turn
// can be retried before the client sees anything — which is what a user would
// otherwise do by hand with "continue".
export const GUARDRAIL_LABEL = '[Quick 审核拦截] '
export const GUARDRAIL_RETRY_NUDGE = 'Continue the previous request. The last attempt was stopped by a server-side content check before any answer; produce the answer now and call client tools with <tool_call> blocks.'
const GUARDRAIL_PHRASES = [
  'that content did not pass our automated check',
  "the model's content filter stopped this reply",
  'the ai service encountered a temporary issue',
  'something went wrong',
]

/** Whole-message match on the canned guardrail sentences. */
export function isGuardrailText(text: any) {
  const t = normalizePseudo200(String(text ?? '')).replace(/[.!,;:—–-]+$/g, '').trim()
  if (!t || t.length > 160) return false
  return GUARDRAIL_PHRASES.some((p) => t === p || t.startsWith(p))
}

function normalizePseudo200(text: string) {
  return text.trimStart().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ')
}

/** Exact whole-message match — the reply is nothing but the quota sentence. */
export function isPseudo200UsageLimitText(text: any) {
  const norm = normalizePseudo200(String(text ?? '')).trimEnd()
  if (!norm || norm.length > 140) return false
  return /^you(?:'ve| have) reached your usage limit\.\s*check your profile for details\.?$/i.test(norm)
}

/** Streaming prefix match — text so far could still become the quota sentence. */
export function isPseudo200UsageLimitPrefix(text: any) {
  const norm = normalizePseudo200(String(text ?? ''))
  if (!norm) return true
  if (norm.length > 80) return false
  return PSEUDO200_PHRASES.some((phrase) => phrase.startsWith(norm))
}

/** usage_limit failure type on an error/guardrail event payload (real error frames). */
function isUsageLimitPayload(p: any) {
  if (!p || typeof p !== 'object') return false
  for (const k of ['error_type', 'errorType', 'failure_type', 'failureType', 'code', 'reason', 'error', 'type']) {
    if (String(p[k] ?? '') === 'usage_limit') return true
  }
  return false
}

const QUOTA_ERR = 'Quick 账号用量已用尽（usage limit），请等待额度重置或更换账号'

/** Usage object from a turn_usage event payload (snake_case wire fields). */
export function usageFrom(u: any) {
  if (!u || typeof u !== 'object') return null
  const input = Number(u.input_tokens ?? u.inputTokens) || 0
  const cached = Number(u.cache_read_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens) || 0
  const written = Number(u.cache_write_tokens ?? u.cacheWriteTokens) || 0
  const completion = Number(u.output_tokens ?? u.outputTokens) || 0
  // Quick reports non-cached input, cache reads and cache writes separately;
  // OpenAI prompt_tokens is the whole prompt side.
  const prompt = input + cached + written
  const total = Number(u.total_tokens ?? u.totalTokens) || prompt + completion
  const cost = Number(u.cost_usd ?? u.costUsd)
  const ctx = Number(u.context_window ?? u.contextWindow)
  const resolved = u.resolved_model_id ?? u.served_model_id ?? u.resolvedModelId
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    // Quick-reported extras; OpenAI clients ignore unknown usage fields.
    ...(Number.isFinite(cost) && cost > 0 ? { cost } : {}),
    ...(Number.isFinite(ctx) && ctx > 0 ? { context_window: ctx } : {}),
    ...(typeof resolved === 'string' && resolved ? { resolved_model_id: resolved } : {}),
  }
}

export function addUsage(acc: any, u: any) {
  if (!u) return acc
  acc = acc ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  // Each agentic step re-reads the whole thread, so summing prompts counted
  // the same context once per step — clients size their context window from
  // prompt_tokens (Claude Code auto-compacted on it). The prompt is the
  // latest step's; only completions accumulate.
  if (u.prompt_tokens) {
    acc.prompt_tokens = u.prompt_tokens
    if (u.prompt_tokens_details?.cached_tokens) acc.prompt_tokens_details = { cached_tokens: u.prompt_tokens_details.cached_tokens }
    else delete acc.prompt_tokens_details
  }
  acc.completion_tokens += u.completion_tokens || 0
  acc.total_tokens = acc.prompt_tokens + acc.completion_tokens
  if (u.cost) acc.cost = (acc.cost || 0) + u.cost
  // Window and model are per-turn facts, not sums: keep the latest.
  if (u.context_window) acc.context_window = u.context_window
  if (u.resolved_model_id) acc.resolved_model_id = u.resolved_model_id
  return acc
}

const newCallId = () => `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`

function progressEvent(evt: any): boolean {
  const t = evt?.type
  if (t === 'keepalive' || t === 'ping' || t === 'pong') return false
  // UI bookkeeping, not generation: a stuck turn keeps emitting these.
  if (t === 'runs_updated' || t === 'task_list_update' || t === 'title_generated' || t === 'session_summary_updated' || t === 'session_sync') return false
  if (t === 'status') {
    const s = evt?.payload?.status || evt?.payload?.message || ''
    if (/pong|ok/i.test(String(s))) return false
  }
  return true
}

/**
 * Interpret one Quick turn. Mutates `state` (text/reasoning/usage/calls) and
 * `salvage` (native calls, dropped call), yields normalized items. Throws
 * QuickWsError kind 'quota' | 'guardrail' | 'stream' on failure — the caller
 * owns retry policy.
 */
export async function* consumeTurn(
  events: AsyncIterable<any>,
  tid: string,
  state: StreamState,
  salvage: Salvage,
  opts: ConsumeOptions,
  hooks: ConsumeHooks = {},
): AsyncGenerator<TurnItem> {
  const { tools, canonClientTool, showQuickTools } = opts
  let parser = tools.length ? createToolCallParser() : null
  // Quick's memory citations (<sources>[…](mem://…)</sources>) still leak past
  // the prompt note now and then; strip them from the visible text.
  let sources = createSourcesStripper()
  let fedText = false
  // Salvage state for native client-tool calls (see canonClientTool):
  // tool_ids that produced a call; salvage.salvageCalls holds them.
  const salvagedIds = new Set<any>()
  // native client calls started but whose arguments haven't arrived yet — a
  // step can hold several (parallel Edits); stopping on the first tool_result
  // would cut the rest off
  const pendingNative = new Set<any>()
  // End the Quick turn once salvaged calls exist and the model step ends —
  // the hook sends stop_generation and aborts the turn so closing the
  // generator can't hang on a silent Quick.
  const endSalvage = () => hooks.onSalvageStop?.()
  // Pseudo-200 quota probe: hold back the turn's first text while it could
  // still be the fixed "usage limit" sentence (see isPseudo200* above). The
  // buffer flushes as ordinary text the moment it diverges; if the turn ends
  // with nothing but that sentence it is quota exhaustion, not a reply.
  let quotaProbe = true
  let quotaBuf = ''

  function* emitParsed(r: { text?: string; calls?: any[] }): Generator<TurnItem> {
    // r: {text, calls:[{name,arguments}]} — yields normalized items, mutates state.
    const text = r.text ? sources.push(r.text) : ''
    if (text) { state.text += text; yield { type: 'text', text } }
    for (const c of r.calls ?? []) {
      const id = newCallId()
      state.calls.push({ id, name: c.name })
      yield { type: 'tool_call', id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
    }
  }

  for await (const evt of events) {
    if (progressEvent(evt)) hooks.onProgress?.()
    const t = evt.type
    const p = evt.payload || {}
    if (t === 'text_delta' && typeof p.delta === 'string') {
      fedText = true
      let delta = p.delta
      if (quotaProbe) {
        quotaBuf += delta
        if (quotaBuf.length <= 160 && isPseudo200UsageLimitPrefix(quotaBuf)) continue
        quotaProbe = false
        delta = quotaBuf
        quotaBuf = ''
      }
      yield* emitParsed(parser ? parser.push(delta) : { text: delta, calls: [] })
    } else if (t === 'thinking_delta' && typeof p.delta === 'string') {
      state.reasoning += p.delta
      yield { type: 'reasoning', text: p.delta }
    } else if (t === 'tool_start' && showQuickTools && typeof p.tool_name === 'string' && p.tool_name && !canonClientTool(p.tool_name)) {
      // Quick runs its own tools server-side; surface each one as a reasoning
      // line so long agentic turns don't look dead. Client-tool names are
      // skipped — the salvaged call itself is the surface.
      const note = `\n[Quick: ${p.tool_name}]\n`
      state.reasoning += note
      yield { type: 'reasoning', text: note }
    } else if (t === 'tool_start' && p.tool_id && canonClientTool(p.tool_name)) {
      pendingNative.add(p.tool_id)
    } else if (t === 'tool_arguments') {
      if (p.tool_id) pendingNative.delete(p.tool_id)
      // Native client call: the full args object just arrived. Emit it like a
      // parsed <tool_call>; the step-end stop happens on the next turn_usage
      // (yielded first) or a tool_result for a salvaged id.
      const canon = canonClientTool(p.tool_name)
      const dup = p.tool_id && salvagedIds.has(p.tool_id)
      if (canon && !dup && p.arguments && typeof p.arguments === 'object') {
        if (p.tool_id) salvagedIds.add(p.tool_id)
        const id = newCallId()
        state.calls.push({ id, name: canon })
        salvage.salvageCalls.push({ name: canon, arguments: JSON.stringify(p.arguments) })
        yield { type: 'tool_call', id, name: canon, arguments: JSON.stringify(p.arguments) }
      }
    } else if (t === 'tool_result' && salvagedIds.has(p.tool_id)) {
      // Quick finished (or failed) a salvaged call — stop before the model's
      // rewrite step burns another agent turn, unless sibling calls of the
      // same step are still streaming their arguments (turn_usage ends the
      // step either way).
      if (pendingNative.size) continue
      endSalvage()
      return
    } else if (t === 'turn_usage') {
      const u = usageFrom(p)
      if (u) { state.usage = addUsage(state.usage, u); yield { type: 'usage', usage: u } }
      if (salvage.salvageCalls.length) { endSalvage(); return }
    } else if (t === 'message_complete') {
      // Fallback: deltas can be dropped; the complete payload carries full text.
      // Only when NO delta arrived — parser buffer would double-count otherwise.
      if (!fedText && typeof p.text === 'string' && p.text) {
        // Whole message in one frame: the quota sentence is detectable outright.
        if (isPseudo200UsageLimitText(p.text)) throw new QuickWsError(QUOTA_ERR, { kind: 'quota' })
        yield* emitParsed(parser ? parser.push(p.text) : { text: p.text, calls: [] })
      }
    } else if (t === 'message_start' || t === 'connected' || t === 'session_established' || t === 'keepalive') {
      // noise
    } else if (t === 'status') {
      const s = p.status || p.message
      // unknown_message_type {received_type:'session_init'}: a server-side
      // status about a frame we never send, seen on every connect with or
      // without an outpostId — noise, not something the user can act on.
      if (s && !/pong|ok|unknown_message_type/i.test(String(s))) yield { type: 'note', text: `[quick] ${s}` }
    } else if (t === 'guardrail_blocked' || t === 'error') {
      // Error details may live in payload OR at the event's top level; dump
      // the whole event (truncated) when nothing readable is found.
      const detail = p.message || p.reason || p.error || evt.message || evt.reason || evt.error || evt.code
      const extra = detail ? '' : ` ${JSON.stringify(evt).slice(0, 400)}`
      if (isUsageLimitPayload(p) || isUsageLimitPayload(evt)) throw new QuickWsError(QUOTA_ERR, { kind: 'quota' })
      const guard = t === 'guardrail_blocked' || isGuardrailText(detail)
      throw new QuickWsError(`${guard ? GUARDRAIL_LABEL : ''}${detail || `quick ${t}`}${extra}`, { kind: guard ? 'guardrail' : 'stream' })
    }
    // tool_progress, runs_updated, task_list_update, title_generated,
    // session_sync … are agent-internal; Quick executes its own tools, so they
    // don't map to OpenAI tool_calls (tool_start is surfaced above as a
    // reasoning note; tool_arguments/tool_result drive the client-tool salvage).
  }
  if (quotaProbe && quotaBuf) {
    // The turn ended with every text delta still consistent with the quota
    // sentence. An exact match is exhaustion — fail as 429 so magpie moves to
    // the next account; anything else was a real reply that merely started
    // alike (or a truncated one): flush it through.
    if (isPseudo200UsageLimitText(quotaBuf)) throw new QuickWsError(QUOTA_ERR, { kind: 'quota' })
    yield* emitParsed(parser ? parser.push(quotaBuf) : { text: quotaBuf, calls: [] })
    quotaBuf = ''
  }
  if (parser) {
    const tail = parser.end()
    if (tail.text) yield* emitParsed({ text: tail.text, calls: [] })
    for (const c of tail.calls ?? []) {
      const id = newCallId()
      state.calls.push({ id, name: c.name })
      yield { type: 'tool_call', id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
    }
    if (tail.dropped) {
      salvage.droppedCall = { reason: tail.dropped, name: tail.droppedName || '' }
      yield {
        type: 'note',
        text: tail.dropped === 'unterminated'
          ? '[quick] 模型的工具调用没写完（回复在 </tool_call> 之前就结束了），这次调用没有执行，已让模型重发'
          : '[quick] 模型的工具调用格式有误（JSON 无法解析），这次调用没有执行，已让模型重发',
      }
      // A turn that ends with no tool call makes agent clients stop and wait
      // for the user. Hand them a placeholder call to a tool that doesn't
      // exist instead: nothing runs, the client answers with an error result
      // and keeps its loop going (verified with Claude Code), and the next
      // turn tells the model what to resend.
      if (!state.calls.length) {
        const id = newCallId()
        const args = JSON.stringify({ tool: salvage.droppedCall.name, reason: tail.dropped })
        state.calls.push({ id, name: INVALID_CALL_TOOL })
        yield { type: 'tool_call', id, name: INVALID_CALL_TOOL, arguments: args }
      }
    }
  }
  const rest = sources.end()
  if (rest) { state.text += rest; yield { type: 'text', text: rest } }
}
