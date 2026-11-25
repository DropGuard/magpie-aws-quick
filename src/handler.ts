// Serve one OpenAI Chat Completions request through an Amazon Quick chat turn.
//
// Quick has no OpenAI-shaped HTTP API: the desktop client talks to a bidi
// WebSocket (`session_connect` → `user_message` → text_delta/thinking_delta/…
// → message_complete). This module renders the OpenAI message list into Quick's
// text protocol, runs the turn on a cached thread, and re-emits the event
// stream as chat.completion / chat.completion.chunk.
//
// OpenAI `tools` have no wire channel either, but the model emits a
// caller-defined <tool_call>{json}</tool_call> convention as plain text when
// the instruction is inline and strong (verified live). src/tools.ts owns the
// preamble + streaming parser; results return as role:'tool' messages rendered
// into the next turn's text.
import { QuickSocket, QuickWsError } from './quickws.ts'
import { OutpostError } from './outpost.ts'
import { isPermissionReview, prepareReview, materializeReview, readReview } from './review.ts'
import { profileUsage } from './usage.ts'
import { buildTurnContext, composeAttempt } from './turn/plan.ts'
import {
  consumeTurn, usageFrom, GUARDRAIL_LABEL, GUARDRAIL_RETRY_NUDGE,
} from './turn/consume.ts'
import type { StreamState, Salvage } from './turn/consume.ts'
import { createWatchdog } from './turn/watchdog.ts'
import { rememberTurn, restoreTaken } from './turn/session.ts'
import { errorResponse, errorType, httpStatus, makeId, respondWithItems } from './http/respond.ts'
import { primeItems } from './http/pump.ts'
import { nextRetry } from './runtime/retry.ts'
import {
  AGENT_MODES, MODELS, modeFor, effortFor, textOf,
} from './translate.ts'

const SURFACE = 'QUICK_WORK_DESKTOP_WINDOWS'
const APP_VERSION = '1.2.4660'
// Numeric plugin option with a default; 0 is a real value (disables the timer).
const msOpt = (v, fallback) => {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// Planning (instructions, preamble, history render, payload assembly) lives in
// turn/plan.ts. Its client-facing notes are re-exported here: they are part of
// this module's contract (and tests import them from here).
export { PLAIN_TEXT_NOTE, TOOLS_STILL_APPLY, INVALID_CALL_TOOL, cutNote } from './turn/prompts.ts'
export { isPseudo200UsageLimitText, isPseudo200UsageLimitPrefix, isGuardrailText } from './turn/consume.ts'

// ---------------------------------------------------------------------------
// Session-bucket failover: once a turn hits quota exhaustion, remember WHEN
// the account is usable again and fail fast (429) until then — magpie moves
// to the next account immediately instead of burning a turn per request.
// Keyed by identity; one refresh in flight per account.
// ---------------------------------------------------------------------------
const quotaWindows = new Map()
const quotaRefresh = new Map()

/** How long the account stays exhausted per profile/usage buckets. */
export function exhaustionMinutes(usage) {
  const s = usage?.session
  if (s?.exhausted) {
    const r = Number(s.resumeInMinutes)
    // server says when the window resumes; fall back to a conservative 30
    return Number.isFinite(r) && r > 0 ? r : 30
  }
  const m = usage?.monthly
  if (m?.exhausted) {
    if (m.resetsAt) return Math.max(1, (new Date(m.resetsAt).getTime() - Date.now()) / 60000)
    return 24 * 60
  }
  return 0
}

function quotaMarkExhausted(identity, getSession, log) {
  const win = quotaWindows.get(identity) || {}
  win.exhaustedAt = Date.now()
  if (!win.until || win.until < Date.now() + 60000) win.until = Date.now() + 15 * 60000 // conservative default until the probe refines it
  quotaWindows.set(identity, win)
  if (quotaRefresh.has(identity)) return
  const p = (async () => {
    try {
      const usage = await profileUsage(getSession)
      const mins = exhaustionMinutes(usage)
      const w = quotaWindows.get(identity)
      if (!w) return
      if (mins > 0) {
        w.until = Date.now() + mins * 60000
        log?.(`[quota] ${identity}: session/monthly bucket exhausted, skipping account for ~${Math.round(mins)}min`)
      } else {
        // buckets look fine — the limit we hit was something else; keep a short cooldown
        w.until = Date.now() + 5 * 60000
        log?.(`[quota] ${identity}: usage_limit hit but buckets not exhausted; short 5min cooldown`)
      }
    } catch { /* keep the default window */ }
    finally { quotaRefresh.delete(identity) }
  })()
  quotaRefresh.set(identity, p)
}

/** Minutes left if this identity is inside an exhaustion window, else 0. */
export function quotaCooldownLeft(identity) {
  const win = quotaWindows.get(identity)
  if (!win?.until) return 0
  const left = win.until - Date.now()
  if (left <= 0) { quotaWindows.delete(identity); return 0 }
  return left / 60000
}

/** Test hook: clear all quota windows. */
export function resetQuotaWindows() { quotaWindows.clear(); quotaRefresh.clear() }

const sockets = new WeakMap() // Outpost → QuickSocket

async function socketFor(outpost, options) {
  let s = sockets.get(outpost)
  if (!s) {
    const outpostId = await outpost.outpostId()
    // OAuth-provisioned sessions (direct backend) have no local outpost; the
    // server accepts an empty outpostId. A *local* outpost returning none is a
    // real auth failure though.
    if (!outpostId && !outpost.direct) throw new OutpostError('outpost 未返回设备 id（/local/outpost-id），请确认已登录 Amazon Quick', { kind: 'auth', status: 401 })
    s = new QuickSocket({
      getSession: () => outpost.session(),
      outpostId,
      extra: {
        surfaceType: options?.surfaceType || SURFACE,
        appVersion: options?.appVersion || APP_VERSION,
        channel: options?.channel,
      },
      log: options?.log,
    })
    sockets.set(outpost, s)
  }
  return s
}


/**
 * Normalized turn output:
 *   {type:'meta', threadId, reused, mode}
 *   {type:'text', text}                 visible answer delta
 *   {type:'reasoning', text}            thinking_delta
 *   {type:'tool_call', id, name, arguments}   parsed <tool_call> block (arguments = JSON string)
 *   {type:'usage', usage}               turn_usage (per message)
 *   {type:'note', text}                 non-fatal oddities worth showing
 *   {type:'done', …}                    terminal bookkeeping
 */
async function* runTurn({ outpost, socket, body, systemText, base, review, sessions, options, signal }) {
  const mode = base.agent_mode
  if (review) {
    // Reviews are one-shot even when Magpie supplied the main chat's session ID.
    try {
      const result = await readReview(socket, review, signal, msOpt(options?.idleTimeoutMs, 300_000))
      yield { type: 'meta', threadId: review.threadId, reused: false, mode }
      for (const u of result.usage) yield { type: 'usage', usage: usageFrom(u) }
      yield { type: 'text', text: result.text }
    } finally {
      // A primed review thread goes back to the pool for the next check.
      if (review.slot) review.slot.inflight = Math.max(0, review.slot.inflight - 1)
    }
    return
  }
  const ctx = buildTurnContext({ body, outpost, sessions, options, signal, systemText, base })
  const { convo, tools, scope, hashes, sessionKey, taken, reuse, canonClientTool, showQuickTools } = ctx
  let threadId = reuse ? reuse.entry.threadId : crypto.randomUUID()
  const first = await composeAttempt(ctx, { threadId, reuse })
  let payload = first.payload
  let toolNames = first.toolNames
  let reused = first.reused

  const state: StreamState = { text: '', reasoning: '', usage: null, calls: [] }
  // Client-tool calls salvaged from Quick's native channel this turn
  // ({name, arguments} — arguments already JSON). Quick discards the stopped
  // step server-side, so the session entry carries these and the NEXT reused
  // turn re-states them before the tool results (composeAttempt's reuse branch).
  const salvage: Salvage = { salvageCalls: [], droppedCall: null }
  const consumeOpts = { tools, canonClientTool, showQuickTools }

  yield { type: 'meta', threadId, reused, mode }
  // What the client will store as this assistant message: text chunks and
  // notes, in stream order. Thread reuse hashes our reply against the client's
  // history, so a note left out here breaks the chain on the NEXT turn and
  // every note would start a new thread (subagents did exactly that).
  let clientText = ''
  // The attempt's note is yielded before the turn loop, so it must also be
  // added to the client-visible text here — the reply we hash has to match
  // what the client stores, or the next turn starts a new thread.
  if (first.note) {
    clientText += `\n\n> ${first.note}`
    yield { type: 'note', text: first.note }
  }

  // Quick's own stop message (the frame the desktop sends on stop): socket.stop
  // sends it AND arms the per-thread settle window, so the next turn() on this
  // thread waits out Quick's stale terminal-event tail instead of losing its
  // user_message. Covers watchdog timeout, client abort and tool salvage.
  const stopTurn = (tid: string) => {
    try { socket.stop(tid) } catch {}
  }
  const watchdog = createWatchdog({ idleMs: msOpt(options?.idleTimeoutMs, 300_000), signal })
  const consumeHooks = {
    onProgress: () => watchdog.bump(),
    // stopGeneration + abort: the turn signal wakes the parked socket.turn
    // waiter so closing the generator can't hang on a silent Quick.
    onSalvageStop: () => { stopTurn(threadId); watchdog.abort() },
  }

  const produced = () => state.text.length > 0 || state.calls.length > 0 || state.reasoning.length > 0
  let turnOk = false
  // A guardrail stop ends the turn with no answer at all (measured: those
  // replies carry usage 0/0). Retry it here, before the client is handed the
  // canned sentence — the user's alternative was typing "continue" by hand.
  // Bounded, same account, and `guardrailRetries: 0` turns it off.
  const guardMax = Math.max(0, Math.floor(msOpt(options?.guardrailRetries, 1)))
  let guardTries = 0
  // A fresh-thread retry is the last attempt: failures from it surface as-is
  // (the old inline copy did exactly that — no guardrail loop on the retry).
  let freshTried = false
  try {
    for (;;) {
      try {
        for await (const o of consumeTurn(socket.turn(threadId, payload, { signal: watchdog.signal }), threadId, state, salvage, consumeOpts, consumeHooks)) {
          if (o.type === 'text') clientText += o.text
          else if (o.type === 'note') clientText += `\n\n> ${o.text}`
          yield o
        }
        turnOk = true
        break
      } catch (e) {
        const term = watchdog.termination(e, threadId, stopTurn)
        if (term) throw term
        if (freshTried) throw e
        const action = nextRetry({ guardTries, guardMax, reused: !!(reuse && sessions), produced: produced() }, e)
        if (action.type === 'guardrail-retry') {
          guardTries++
          payload.text = GUARDRAIL_RETRY_NUDGE
          payload.message_id = crypto.randomUUID()
          watchdog.bump()
          options?.log?.(`[aws-quick] guardrail blocked the turn; retrying (${guardTries}/${guardMax})`)
          const retryNote = `${GUARDRAIL_LABEL}服务端拦截了这次回复，正在自动重试（${guardTries}/${guardMax}）`
          clientText += `\n\n> ${retryNote}`
          yield { type: 'note', text: retryNote }
          continue
        }
        if (action.type === 'stop') throw e
        // Cached thread may be gone server-side: retry once on a fresh thread
        // with the full transcript (same policy as magpie-comate). Uploaded
        // files live in the dead thread's workspace, so they are delivered
        // again — exactly what composeAttempt's retry mode assembles.
        const fresh = crypto.randomUUID()
        taken.length = 0 // the cached thread is the dead one — nothing to put back
        const second = await composeAttempt(ctx, { threadId: fresh, reuse: null, retry: true })
        state.text = ''
        state.reasoning = ''
        state.usage = null
        state.calls = []
        salvage.salvageCalls.length = 0
        salvage.droppedCall = null
        threadId = fresh
        reused = false
        freshTried = true
        toolNames = second.toolNames
        payload = second.payload
        yield { type: 'meta', threadId: fresh, reused: false, mode }
        if (second.note) { clientText += `\n\n> ${second.note}`; yield { type: 'note', text: second.note } }
      }
    }
  } finally {
    watchdog.dispose()
    // errors, watchdog and client cancels (generator return) all land here
    if (!turnOk && sessions) restoreTaken(sessions, taken)
  }

  // Remember where this conversation stands for the next request.
  if (sessions && (state.text || state.calls.length)) {
    rememberTurn({ sessions, scope, hashes, convo, sessionKey, threadId, toolNames, clientText, state, salvage })
  } else if (sessions) restoreTaken(sessions, taken)
  yield { type: 'done', threadId, text: state.text, reasoning: state.reasoning, usage: state.usage }
}

/**
 * @param {object} p
 * @param {object} p.body       parsed Chat Completions request
 * @param {object} p.outpostMgr createOutpostManager() result
 * @param {object} [p.sessions] session store (src/sessions.ts)
 * @param {object} [p.options]  plugin options
 * @param {string} [p.effortHeader] X-Magpie-Effort style header value
 * @param {AbortSignal} [p.signal]
 */
export async function handleChatCompletions({ body, outpostMgr, sessions, options, effortHeader, signal }) {
  if (!body || typeof body !== 'object') return errorResponse(400, 'request body must be JSON', 'invalid_request_error')
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return errorResponse(400, 'messages is required', 'invalid_request_error')
  }
  if (body.messages.some(m => !m || typeof m !== 'object')) {
    return errorResponse(400, 'each message must be an object', 'invalid_request_error')
  }
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'smart'
  const messages = body.messages
  const systemText = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => textOf(m.content)).join('\n\n')
  const mode = modeFor(model)
  const effort = effortFor(effortHeader, body)
  const base: any = {
    message_id: crypto.randomUUID(), agent_mode: mode,
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    user_locale: (Intl.DateTimeFormat().resolvedOptions().locale || 'en-US').replace('_', '-'),
  }
  if (effort) base.thinking_effort = effort
  if (options?.chatAgentId) base.chat_agent_id = options.chatAgentId
  let review
  if (isPermissionReview(systemText, messages, body.tools)) {
    const threadId = crypto.randomUUID()
    try {
      review = prepareReview(messages, systemText, base, threadId)
    } catch (err) {
      return errorResponse(err.status ?? 422, err.message, 'invalid_request_error')
    }
  }
  const identity = options?.identity || 'local'
  const cdMin = quotaCooldownLeft(identity)
  if (cdMin > 0) {
    return errorResponse(429, `Amazon Quick usage limit reached; this account resumes in ~${Math.ceil(cdMin)} minutes (session window). Failing fast so another account can serve the request.`, 'rate_limit_error')
  }
  let outpost
  try {
    outpost = await outpostMgr.ensure()
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }
  let socket
  try {
    socket = await socketFor(outpost, { ...options, effortHeader, log: options?.log })
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }
  if (review?.prime) {
    // The policy exceeded one frame: prime it into a dedicated thread's
    // history (a few plain turns), then review on that thread.
    try {
      review = await materializeReview(socket, review, base, signal)
    } catch (e) {
      return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
    }
  }

  const noteQuota = (e) => {
    if (e?.kind === 'quota' || e?.status === 429) quotaMarkExhausted(identity, () => outpost.session(), options?.log)
    return e
  }
  const it = runTurn({ outpost, socket, body, systemText, base, review, sessions, options, signal })

  // Pull up to the first real output before answering so auth/session failures
  // surface as real HTTP statuses (magpie marks the account on 401, fails over
  // on 429/5xx) instead of a 200 stream that dies immediately.
  let primed
  try {
    primed = await primeItems(it, {
      stream: !!body.stream,
      headerWaitMs: msOpt(options?.headerWaitMs, 10_000),
    })
  } catch (e) {
    noteQuota(e)
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }
  const { meta, items } = primed

  const created = Math.floor(Date.now() / 1000)
  return respondWithItems(items, {
    id: makeId(meta?.threadId),
    created,
    model,
    stream: !!body.stream,
    includeUsage: !!body.stream_options?.include_usage,
    onError: noteQuota,
    onCancel: () => { items.return?.(); it.return?.() },
  })
}

/** /v1/models in OpenAI shape. */
export function handleModels() {
  return new Response(JSON.stringify({ object: 'list', data: MODELS }), {
    headers: { 'content-type': 'application/json' },
  })
}

export { AGENT_MODES }
