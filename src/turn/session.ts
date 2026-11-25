// Remembering where a finished turn leaves the conversation.
//
// The next request is matched by a hash chain over the client's message list
// plus the assistant message the client actually stores — so the reply we hash
// must be built from the client-visible text (notes included) and the calls we
// emitted. This used to be the last 20 lines of the turn generator, mixed in
// with hash/anchor bookkeeping and the salvage flags.
import { extendHash, replyAnchor, replyMessage, tailAnchor } from '../sessions.ts'
import type { Salvage, StreamState } from './consume.ts'

/** Put reused entries back after a failed/cancelled turn. */
export function restoreTaken(sessions: any, taken: [string, any][]) {
  for (const [k, e] of taken) if (!sessions.has(k)) sessions.set(k, e)
  taken.length = 0
}

export interface RememberInput {
  sessions: any
  scope: string
  hashes: string[]
  convo: any[]
  sessionKey: string
  threadId: string
  toolNames: string[]
  /** What the client stores as this assistant message (text + notes, in order). */
  clientText: string
  state: StreamState
  salvage: Salvage
}

/** Store the turn's thread under the reply hash and both resume anchors. */
export function rememberTurn({ sessions, scope, hashes, convo, sessionKey, threadId, toolNames, clientText, state, salvage }: RememberInput) {
  const reply = replyMessage(clientText, state.calls)
  const key = extendHash(hashes[convo.length], reply)
  // salvageCalls ride the entry so the next reused turn can re-state the
  // interrupted call (memory only — the file store keeps hashes + threadIds,
  // never message content, so a reloaded entry simply lacks the prefix).
  const salvaged = {
    ...(salvage.salvageCalls.length ? { salvageCalls: salvage.salvageCalls } : {}),
    ...(salvage.droppedCall ? { droppedCall: salvage.droppedCall } : {}),
  }
  sessions.set(key, {
    threadId,
    toolNames,
    replyKey: replyAnchor(scope, reply),
    tailKey: tailAnchor(scope, convo.slice(-3)),
    ...salvaged,
  })
  // Session-keyed entry self-perpetuates: rewritten every turn so the fallback
  // survives however much the client rewrites its history.
  if (sessionKey) sessions.set(`sess:${scope}:${sessionKey}`, { threadId, toolNames, callIds: state.calls.map((c) => c.id), ...salvaged })
}
