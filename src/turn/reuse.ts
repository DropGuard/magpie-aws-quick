// Resolving which Quick thread a request continues.
//
// One matcher, ported from magpie-aws-quick-bridge: the same account and
// conversation key, the stored message keys as a PREFIX of the new request's
// keys, and a new tail that is user/tool only. Assistant messages are the
// wildcard "assistant" (the client resends its own rendering of the reply);
// user/tool messages are content hashes, so an edited history or a client-side
// compaction starts a new thread instead of appending to a stale one.
//
// Matching REMOVES the entry from the store so two requests cannot append to
// one thread; the caller puts it back if the turn never commits.
import { threadKeys } from '../sessions.ts'
import type { ThreadEntry } from '../sessions.ts'

/** A cached thread this turn may append to. */
export interface Reuse {
  entry: ThreadEntry
  /** Messages after the stored prefix — what this turn may append. */
  delta: any[]
}

export interface ReuseDecision {
  reuse?: Reuse
  /** Entries removed for reuse — returned on failure/cancel. */
  taken: ThreadEntry[]
}

/**
 * @param sessionKey stable gateway session id (x-magpie-session), optional
 */
export function resolveReuse({ sessions, identity, convo, sessionKey }: {
  sessions: any
  identity: string
  convo: any[]
  sessionKey: string
}): ReuseDecision {
  if (!sessions) return { taken: [] }
  const keys = threadKeys(convo)
  const hit = sessions.match({ account: identity, session: sessionKey || '', keys })
  if (!hit) return { taken: [] }
  return {
    reuse: { entry: hit, delta: convo.slice(hit.keys.length) },
    taken: [hit],
  }
}
