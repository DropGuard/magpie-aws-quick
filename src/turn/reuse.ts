// Resolving which Quick thread a request continues.
//
// Three matchers, strongest first: the strict hash chain over the client's
// message list, fuzzy anchors around our last reply (survives history rewrites
// by context extensions), and the gateway's session key as a last resort.
// Matching REMOVES the entry from the store so two requests cannot append to
// one thread; the caller puts it back if the turn never commits. This is the
// 80 lines that used to sit in the middle of buildTurnContext.
import { canonRole } from '../translate.ts'
import { chainHashes, findContinuation, replyAnchor, sessionScope, tailAnchor } from '../sessions.ts'

/** A cached thread this turn may append to. */
export interface Reuse {
  entry: any
  /** Messages after the anchored reply — what this turn may append. */
  delta: any[]
}

export interface ReuseDecision {
  /** Hash-chain seed for this conversation (account + mode + system text). */
  scope: string
  hashes: string[]
  reuse?: Reuse
  /** Entries removed for reuse — returned on failure/cancel. */
  taken: [string, any][]
}

/**
 * @param sessionKey stable gateway session id (x-magpie-session), optional
 */
export function resolveReuse({ sessions, identity, mode, systemText, convo, sessionKey }: {
  sessions: any
  identity: string
  mode: string
  systemText: string
  convo: any[]
  sessionKey: string
}): ReuseDecision {
  // Thread identity: account, agent mode and the caller's system text (which
  // separates main agent, subagents and the permission reviewer). Thinking
  // effort is a per-turn field, and tools are tracked on the entry instead —
  // Claude Code adds tools mid-session (ToolSearch, skills), and each change
  // used to throw away a thread holding the whole conversation (#11).
  const scope = sessionScope(identity, mode, systemText, null)
  const hashes = chainHashes(scope, convo)
  const cont = sessions ? findContinuation(sessions, hashes, convo) : undefined
  // Entries taken for reuse. Matching removes them up front so two requests
  // can't append to one thread; if this turn then fails or is cancelled
  // without committing a new entry, they go back — otherwise one 499/502/503
  // would strand a thread holding the whole conversation.
  const taken: [string, any][] = cont ? [[cont.key, cont.entry]] : []
  // Fuzzy resume: context extensions (pi-magic-context, rewind hooks, …) can
  // prune or rewrite old messages, breaking the strict prefix chain. Anchor on
  // our last reply echo + its 3 predecessors — content hashes survive the
  // position shifts such edits cause. Only the LAST assistant can yield an
  // appendable delta anyway.
  let fuzzy: Reuse | undefined
  if (!cont && sessions) {
    let a = -1
    for (let i = convo.length - 1; i >= 0; i--) {
      if (canonRole(convo[i]?.role) === 'assistant') { a = i; break }
    }
    if (a >= 3) {
      const rk = replyAnchor(scope, convo[a])
      const tk = tailAnchor(scope, convo.slice(a - 3, a))
      const hit = sessions.findEntry((e) => e.replyKey === rk && e.tailKey === tk)
      if (hit) {
        const delta = convo.slice(a + 1)
        if (delta.length && delta.every((m) => ['user', 'tool', 'function'].includes(canonRole(m.role)))) {
          sessions.take(hit.key)
          taken.push([hit.key, hit.entry])
          fuzzy = { entry: hit.entry, delta }
        }
      }
    }
  }
  // Session-keyed fallback: gateways like magpie stamp every request of a
  // chat with a stable session id (x-magpie-session). When content matching
  // fails entirely — heavy client-side compaction rewrites even our reply
  // echo — the session boundary still identifies the conversation, so trust
  // it and append whatever follows the last assistant message. Verified
  // matches (strict/fuzzy) always win; this is the last resort.
  let sessHit: Reuse | undefined
  if (!cont && !fuzzy && sessions && sessionKey) {
    const sk = `sess:${scope}:${sessionKey}`
    if (sessions.has(sk)) {
      let a = -1
      for (let i = convo.length - 1; i >= 0; i--) {
        if (canonRole(convo[i]?.role) === 'assistant') { a = i; break }
      }
      if (a >= 0) {
        const delta = convo.slice(a + 1)
        if (delta.length && delta.every((m) => ['user', 'tool', 'function'].includes(canonRole(m.role)))) {
          const entry = sessions.take(sk)
          // One session id covers every subagent of a Claude Code session
          // (and a gateway may move each request to another account), so the
          // id alone can splice one subagent's tool results into another
          // subagent's thread. Tool results must answer calls this thread
          // made; a plain user follow-up still resumes.
          const resultIds = delta.filter((m) => canonRole(m.role) === 'tool').map((m) => m.tool_call_id).filter(Boolean)
          const ours = new Set(entry?.callIds ?? [])
          if (entry && resultIds.every((id) => ours.has(id))) {
            taken.push([sk, entry])
            sessHit = { entry, delta }
          } else if (entry) sessions.set(sk, entry)
        }
      }
    }
  }
  return { scope, hashes, reuse: cont ?? fuzzy ?? sessHit, taken }
}
