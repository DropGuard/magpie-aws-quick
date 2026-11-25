// Serve one OpenAI Chat Completions request through an Amazon Quick chat turn.
//
// Quick has no OpenAI-shaped HTTP API: the desktop client talks to a bidi
// WebSocket (`session_connect` → `user_message` → text_delta/thinking_delta/…
// → message_complete). This module renders the OpenAI message list into Quick's
// text protocol, runs the turn on a cached thread, and re-emits the event
// stream as chat.completion / chat.completion.chunk.
//
// OpenAI `tools` have no wire channel either, but the model emits an
// Anthropic-style XML <invoke>/<parameter> convention as plain text when the
// instruction is inline and strong. src/tools.ts owns the preamble + streaming
// parser; results return as role:'tool' messages rendered as <tool_result>
// blocks in the next turn's text.
import { QuickSocket, QuickWsError } from './quickws.ts'
import { OutpostError } from './outpost.ts'
import { isPermissionReview, prepareReview, materializeReview, readReview } from './review.ts'
import { profileUsage } from './usage.ts'
import { buildTurnContext, composeAttempt } from './turn/plan.ts'
import {
  consumeTurn, usageFrom, droppedItems, GUARDRAIL_LABEL, GUARDRAIL_RETRY_NUDGE,
} from './turn/consume.ts'
import type { StreamState, Salvage } from './turn/consume.ts'
import { createWatchdog } from './turn/watchdog.ts'
import { rememberTurn, restoreTaken } from './turn/session.ts'
import { EMPTY_ANSWER_NUDGE, EMPTY_ANSWER_LABEL, EMPTY_ANSWER_ERR, agentNeutral } from './turn/prompts.ts'
import { errorResponse, errorType, httpStatus, makeId, respondWithItems } from './http/respond.ts'
import { primeItems } from './http/pump.ts'
import { nextRetry } from './runtime/retry.ts'
import {
  AGENT_MODES, MODELS, modeFor, effortFor, capEffort, lowerEffort, textOf, byteLen,
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

// One turn per client conversation at a time. Clients send the next user
// message as soon as the previous answer is complete; the plugin may still be
// committing that turn's session entry (measured: the entry landed at :13,
// the next request started at :10). Matching then sees a stale prefix, rejects
// the tail that contains the missing assistant, and starts a fresh thread in
// the middle of a conversation. A bounded wait closes that window without
// serializing different conversations.
const turnLanes = new Map<string, Promise<void>>()
const LANE_WAIT_MS = 8_000

async function holdTurnLane(key: string) {
  if (!key) return () => {}
  const prev = turnLanes.get(key)
  if (prev) {
    let timer: any
    await Promise.race([prev, new Promise<void>((resolve) => { timer = setTimeout(resolve, LANE_WAIT_MS); timer.unref?.() })])
    clearTimeout(timer)
  }
  let resolve!: () => void
  const held = new Promise<void>((r) => { resolve = r })
  turnLanes.set(key, held)
  let released = false
  return () => {
    if (released) return
    released = true
    if (turnLanes.get(key) === held) turnLanes.delete(key)
    resolve()
  }
}

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
 *   {type:'tool_call', id, name, arguments}   parsed <invoke> block (arguments = JSON string)
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
  const { convo, tools, identity, sessionKey, taken, reuse, canonClientTool, showQuickTools } = ctx
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
  const consumeOpts = { tools, canonClientTool, showQuickTools, contextWindowCap: Number(options?.contextWindow) > 0 ? Number(options.contextWindow) : 1_000_000 }

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
  // Reasoning-only turns: Quick finishes normally with thinking and no text
  // and no call. The client stores an empty assistant message, shows
  // "Thought for Ns", and waits for the user. Retrying this by default would
  // buy another multi-minute silence, not correctness — so the default is to
  // fail loudly and let the caller decide (`answerRetries` opts into a retry,
  // same thread, one effort level lower).
  const answerMax = Math.max(0, Math.floor(msOpt(options?.answerRetries, 0)))
  let answerTries = 0
  // A malformed <invoke> is a protocol failure, not an answer: retry it
  // inside this request before the client sees the placeholder error. The
  // observed failure was two "No such tool available" errors in a row for a
  // Bash call whose JSON had unescaped quotes.
  const callMax = Math.max(0, Math.floor(msOpt(options?.callRetries, 1)))
  let callTries = 0
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
        // A dropped <invoke> (unterminated, or a bad parameter) is
        // the one failure the client cannot help with: handing it the
        // placeholder produces a visible "No such tool available" error and a
        // whole extra round trip. If nothing else was produced, ask the model
        // to resend it here, on the same thread, before giving up.
        if (salvage.droppedCall) {
          const dc = salvage.droppedCall
          if (!state.text && !state.calls.length && callTries < callMax && !signal?.aborted) {
            callTries++
            const nudge = dc.reason === 'unterminated'
              ? `Your previous <invoke>${dc.name ? ` for ${dc.name}` : ''} ended before </invoke>, so the client never ran it. Resend it as a complete invoke block; if the content is long, split it into several smaller calls.`
              : `Your previous <invoke>${dc.name ? ` for ${dc.name}` : ''} had a missing or malformed parameter, so the client never ran it. Resend it with <invoke name="..."> and one <parameter name="...">value</parameter> per argument; split a long command or content into several calls.`
            const original = String(payload.text ?? '')
            const nudged = `${original}\n\n${nudge}`
            payload.text = byteLen(nudged) <= ctx.frameCap ? nudged : original
            payload.message_id = crypto.randomUUID()
            salvage.droppedCall = null
            watchdog.bump()
            options?.log?.(`[aws-quick] dropped ${dc.reason} tool call; asking for a resend (${callTries}/${callMax})`)
            const retryNote = `[Quick 工具调用重试] 模型的工具调用${dc.reason === 'unterminated' ? '没写完' : ' JSON 不合法'}，正在要求它重发（${callTries}/${callMax}）`
            clientText += `\n\n> ${retryNote}`
            yield { type: 'note', text: retryNote }
            continue
          }
          for (const item of droppedItems(salvage, state)) {
            if (item.type === 'note') clientText += `\n\n> ${item.text}`
            yield item
          }
          turnOk = true
          break
        }
        // The wire turn ended, but only reasoning arrived. From the client's
        // side that is an empty assistant message: Claude Code renders
        // "Thought for Ns" and returns control, so the task silently stalls.
        // Ask again with an explicit "answer now" and one effort level less;
        // if the retry is empty too, surface a real error instead of a blank.
        if (!state.text && !state.calls.length && !signal?.aborted) {
          // After a guardrail retry, an empty turn is the expected leftover:
          // the model spent the retry reading/thinking instead of answering.
          // Ask once more even when answerRetries is 0; the manual "continue"
          // the user would type is exactly this request. Bounded: guardTries
          // and answerTries each cap at 1 here.
          const coupled = guardTries > 0 && answerTries === 0 ? 1 : 0
          const answerBudget = Math.max(answerMax, coupled)
          if (answerTries < answerBudget) {
            answerTries++
            const original = String(payload.text ?? '')
            const nudged = `${original}\n\n${EMPTY_ANSWER_NUDGE}`
            payload.text = byteLen(nudged) <= ctx.frameCap ? nudged : original
            payload.message_id = crypto.randomUUID()
            const lower = lowerEffort(payload.thinking_effort)
            if (lower) payload.thinking_effort = lower
            watchdog.bump()
            options?.log?.(`[aws-quick] turn produced reasoning only; asking for an answer (${answerTries}/${answerBudget}, effort ${payload.thinking_effort ?? 'default'})`)
            const retryNote = `${EMPTY_ANSWER_LABEL}模型只推理、没有作答，正在要求它直接回答（${answerTries}/${answerBudget}）`
            clientText += `\n\n> ${retryNote}`
            yield { type: 'note', text: retryNote }
            continue
          }
          throw new QuickWsError(EMPTY_ANSWER_ERR, { kind: 'empty' })
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
          // Keep what the model was asked to answer. On a fresh thread
          // payload.text is the whole transcript; on a reused thread it is
          // this turn's delta (tool results included). Replacing it with the
          // nudge left the model with nothing but "the last attempt was
          // stopped" — it then told the user the earlier request never
          // arrived. Append instead; if the frame cannot hold the extra
          // bytes, the unchanged text is itself a valid retry.
          const original = String(payload.text ?? '')
          const nudged = `${original}\n\n${GUARDRAIL_RETRY_NUDGE}`
          payload.text = byteLen(nudged) <= ctx.frameCap ? nudged : original
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
    rememberTurn({ sessions, convo, identity, sessionKey, threadId, toolNames, salvage })
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
  const systemText = agentNeutral(messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => textOf(m.content)).join('\n\n'))
  const mode = modeFor(model)
  const requestedEffort = effortFor(effortHeader, body)
  // The old bridge never sent Quick's `max`: anything above medium became
  // `high` (measured there as usable, while the fork's pass-through `max`
  // produced 50–63k-token turns of 8–22 minutes). Mirror that default; a
  // caller that really wants max can set `thinkingEffortCap: 'max'`.
  const effort = capEffort(requestedEffort, options?.thinkingEffortCap ?? 'high')
  if (requestedEffort && effort !== requestedEffort) {
    options?.log?.(`[aws-quick] thinking effort ${requestedEffort} capped to ${effort} (thinkingEffortCap)`)
  }
  const base: any = {
    message_id: crypto.randomUUID(), agent_mode: mode,
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    user_locale: (Intl.DateTimeFormat().resolvedOptions().locale || 'en-US').replace('_', '-'),
    // The old bridge's keep_sessions switch (snake_case is what its settings
    // use): off by default means incognito, i.e. the chat stays out of Quick's
    // list and memory. Send it explicitly so the server does not choose.
    incognito: !(options?.keepSessions === true || options?.keep_sessions === true),
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
  // Acquire BEFORE runTurn: buildTurnContext (the thread match) runs on the
  // first pull. Release via respondWithItems' onSettled, which fires after the
  // stream ends — by then rememberTurn has committed this turn's entry.
  const laneKey = !review && options?.sessionKey ? `${identity}|${options.sessionKey}` : ''
  const releaseLane = await holdTurnLane(laneKey)
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
    releaseLane()
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
    onSettled: releaseLane,
  })
}

/** /v1/models in OpenAI shape. */
export function handleModels() {
  return new Response(JSON.stringify({ object: 'list', data: MODELS }), {
    headers: { 'content-type': 'application/json' },
  })
}

export { AGENT_MODES }
