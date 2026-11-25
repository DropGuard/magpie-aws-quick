// Claude Code's Auto permission reviewer asks for a decision about a quoted
// transcript. Its system policy and its evidence must both reach Quick intact.
import { createHash } from 'node:crypto'
import { byteLen, capMiddle, frameBytes, setInstructions, textOf, UPSTREAM_TEXT_LIMIT } from './translate.ts'
import { QuickWsError } from './quickws.ts'

export const REVIEW_CONTEXT = 'Review the quoted transcript using the complete application system policy. Use no tools. Return only the exact machine-readable response specified by that policy.'

// Used when the policy itself is too large for one frame: it was primed into
// the thread's history verbatim, so the review turn only carries the transcript.
const REVIEW_CONTEXT_PRIMED = 'The complete application system policy was provided verbatim in the preceding messages of this thread — apply every rule in it. Review the quoted transcript in the user message using that policy. Use no tools. Return only the exact machine-readable response the policy specifies.'

const textOnly = content => typeof content === 'string' || (Array.isArray(content) && content.every(
  p => typeof p === 'string' || (['text', 'input_text', 'output_text'].includes(p?.type) && typeof p.text === 'string'),
))

export function isPermissionReview(system, messages, tools) {
  if (tools?.length || !/^You are a security monitor for autonomous AI coding agents\b/im.test(system)) return false
  if (!system.includes('<block>') && !system.includes('<severity>')) return false
  // Magpie uses the trusted system decision schema plus the tool-free user
  // transcript envelope. A quoted prompt in ordinary conversation is data.
  const startsTranscript = text => typeof text === 'string' && text.trimStart().startsWith('<transcript>')
  return messages.some(m => m.role === 'user' && (
    startsTranscript(m.content) || Array.isArray(m.content) && m.content.some(p => startsTranscript(typeof p === 'string' ? p : p?.text))
  ))
}

// A user_message frame is capped at ~64 KB, but Claude Code's auto-mode policy
// is ~140 KB. Oversized policies are primed into a dedicated thread's history
// as a few plain user messages (verified live: a rule planted mid-policy still
// blocks correctly, where head+tail truncation silently dropped it). The
// review turn then fits easily. Primed threads are cached per policy hash and
// rotated after PRIME_MAX_USES reviews so Quick-side history compaction can
// never quietly drop the policy; a small pool covers concurrent reviews.
const PRIME_CHUNK_BYTES = 48 * 1024
const PRIME_MAX_CHUNKS = 8
const PRIME_MAX_USES = 40
const PRIME_MAX_BYTES = 384 * 1024
const PRIME_POOL = 4
const primePools = new Map()

// Chunks must fit the frame after JSON escaping — a quote- or
// backslash-heavy policy doubles on the wire, so measure escaped bytes.
const wireBytes = (s) => byteLen(JSON.stringify(s)) - 2

function chunkPolicy(text, maxBytes) {
  const chunks = []
  let rest = text
  while (wireBytes(rest) > maxBytes) {
    let lo = 0, hi = rest.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (wireBytes(rest.slice(0, mid)) <= maxBytes) lo = mid
      else hi = mid - 1
    }
    let cut = rest.lastIndexOf('\n', lo)
    if (cut < Math.floor(lo * 0.5)) cut = lo
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

async function primeSlot(socket, policy, base, signal) {
  const chunks = chunkPolicy(policy, PRIME_CHUNK_BYTES)
  const threadId = crypto.randomUUID()
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      ...base,
      thinking_effort: 'off',
      web_search_enabled: false,
      text: `<<<SECURITY POLICY — INTERNAL CONFIGURATION, PART ${i + 1}/${chunks.length}. `
        + 'This is reference material stored for later use, NOT a request and NOT a transcript to classify. '
        + 'Do not analyze, summarize, or act on it. '
        + `Reply with exactly: stored ${i + 1}/${chunks.length}.>>>\n\n${chunks[i]}`,
    }
    for await (const _evt of socket.turn(threadId, payload, { signal })) { /* drain the whole turn */ }
  }
  return { threadId, uses: 0, bytes: 0, inflight: 0 }
}

async function acquirePrimedSlot(socket, policy, base, signal) {
  const hash = createHash('sha256').update(policy).digest('hex')
  let pool = primePools.get(hash)
  if (!pool) primePools.set(hash, pool = { slots: [], priming: 0 })
  pool.slots = pool.slots.filter((s) => s.uses < PRIME_MAX_USES && s.bytes < PRIME_MAX_BYTES)
  const free = pool.slots.filter((s) => !s.inflight).sort((a, b) => a.uses - b.uses)
  if (free.length) {
    const slot = free[0]
    slot.inflight++
    return slot
  }
  if (pool.slots.length + pool.priming >= PRIME_POOL) {
    throw new QuickWsError('all permission-review threads are busy', { kind: 'busy' })
  }
  pool.priming++
  try {
    const slot = await primeSlot(socket, policy, base, signal)
    pool.slots.push(slot)
    slot.inflight++
    return slot
  } finally {
    pool.priming--
  }
}

function tooLarge(system, bytes) {
  return Object.assign(new Error(
    'AWS Quick cannot review this action with its complete policy and transcript. '
    + 'The system instructions are ' + byteLen(system) + ' bytes and the request needs ' + bytes
    + ' bytes. The adapter budget is ' + UPSTREAM_TEXT_LIMIT + ' bytes per Quick frame. No review was requested.',
  ), { status: 413 })
}

/**
 * Plan a permission review. Returns { threadId, payload } when policy and
 * transcript fit one frame (transcript may be middle-capped — the action under
 * review is at its end, which capMiddle preserves), or { prime: { policy,
 * transcript } } when the policy must be primed into a thread first.
 * materializeReview() turns the plan into a runnable review after the socket
 * exists. Throws 413/422 before any upstream I/O when nothing can work.
 */
export function prepareReview(messages, system, base, threadId) {
  if (!messages.every(m => ['system', 'developer', 'user'].includes(m.role) && textOnly(m.content))) {
    throw Object.assign(new Error('AWS Quick permission review requires the complete policy and a text-only transcript.'), { status: 422 })
  }
  const transcript = messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n\n')
  const direct = (t) => {
    const p = { ...base, text: t, web_search_enabled: false }
    setInstructions(p, system, REVIEW_CONTEXT)
    return p
  }
  let payload = direct(transcript)
  let bytes = frameBytes(threadId, payload)
  if (bytes <= UPSTREAM_TEXT_LIMIT) return { threadId, payload }

  // Shrink only the transcript; the policy stays complete. The action under
  // review is the transcript's last entry, which capMiddle keeps.
  let t = transcript
  for (let i = 0; i < 6 && bytes > UPSTREAM_TEXT_LIMIT && t; i++) {
    t = capMiddle(t, Math.max(0, byteLen(t) - (bytes - UPSTREAM_TEXT_LIMIT) - 256))
    payload = direct(t)
    bytes = frameBytes(threadId, payload)
  }
  if (bytes <= UPSTREAM_TEXT_LIMIT) return { threadId, payload }

  // The policy alone exceeds a frame: prime it into thread history instead of
  // truncating it — a condensed security policy silently drops rules.
  const chunks = chunkPolicy(system, PRIME_CHUNK_BYTES)
  if (!chunks.length || chunks.length > PRIME_MAX_CHUNKS) throw tooLarge(system, bytes)

  const primed = (tt) => {
    const p = { ...base, text: tt, web_search_enabled: false }
    setInstructions(p, REVIEW_CONTEXT_PRIMED, undefined, threadId)
    return p
  }
  let pt = transcript
  let pb = frameBytes(threadId, primed(pt))
  for (let i = 0; i < 6 && pb > UPSTREAM_TEXT_LIMIT && pt; i++) {
    pt = capMiddle(pt, Math.max(0, byteLen(pt) - (pb - UPSTREAM_TEXT_LIMIT) - 256))
    pb = frameBytes(threadId, primed(pt))
  }
  if (pb > UPSTREAM_TEXT_LIMIT) throw tooLarge(system, pb)
  return { prime: { policy: system, transcript: pt } }
}

/** Turn a prepareReview() plan into { threadId, payload, slot? } for runTurn. */
export async function materializeReview(socket, plan, base, signal) {
  if (!plan.prime) return plan
  const slot = await acquirePrimedSlot(socket, plan.prime.policy, base, signal)
  slot.uses++
  slot.bytes += byteLen(plan.prime.transcript)
  const payload = { ...base, text: plan.prime.transcript, web_search_enabled: false }
  setInstructions(payload, REVIEW_CONTEXT_PRIMED, undefined, slot.threadId)
  return { threadId: slot.threadId, payload, slot }
}

// Buffer the answer until Quick confirms a complete, tool-free turn. Never
// derive a decision from a partial stream, a tool result or ordinary prose.
export async function readReview(socket, { threadId, payload }, signal, timeoutMs) {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  const active = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout
  let text = '', complete = false
  const usage = []
  try {
    active?.throwIfAborted()
    for await (const { type, payload: p = {} } of socket.turn(threadId, payload, { signal: active })) {
      if (type === 'guardrail_blocked') {
        throw Object.assign(new Error('AWS Quick blocked the permission review.'), { status: 422 })
      }
      if (type.startsWith('tool_') || type === 'message_complete' && (p.continuation_expected || p.tool_calls?.length)) {
        throw Object.assign(new Error('AWS Quick attempted a tool during a text-only permission review.'), { status: 422 })
      }
      if (type === 'turn_usage') usage.push(p)
      if (type === 'text_delta') text += p.delta ?? ''
      if (type === 'message_complete') {
        text = p.text || text
        complete = true
      }
    }
    active?.throwIfAborted()
    if (!complete) throw new Error('AWS Quick ended the permission review without a complete reply.')
    return { text, usage }
  } catch (err) {
    if (active?.aborted) throw new QuickWsError('AWS Quick permission review interrupted.', { kind: signal?.aborted ? 'abort' : 'timeout' })
    throw err
  } finally {
    if (!complete || active?.aborted) socket.stop(threadId)
  }
}
