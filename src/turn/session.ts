// Remembering where a finished turn leaves the conversation.
//
// The next request is matched by the message-key prefix: assistant messages
// are wildcards, user/tool messages are content hashes. Only the new user/tool
// tail is appended on the next turn; a changed prefix starts a new thread.
import { threadKeys } from '../sessions.ts'
import type { ThreadEntry } from '../sessions.ts'
import type { Salvage } from './consume.ts'

/** Put reused entries back after a failed/cancelled turn. */
export function restoreTaken(sessions: any, taken: ThreadEntry[]) {
  for (const entry of taken) sessions.restore(entry)
  taken.length = 0
}

export interface RememberInput {
  sessions: any
  convo: any[]
  identity: string
  sessionKey: string
  threadId: string
  toolNames: string[]
  salvage: Salvage
}

/** Commit the thread with the conversation keys the client will resend. */
export function rememberTurn({ sessions, convo, identity, sessionKey, threadId, toolNames, salvage }: RememberInput) {
  // salvageCalls ride the entry so the next reused turn can re-state the
  // interrupted call (memory only — the file store keeps hashes + threadIds,
  // never message content, so a reloaded entry simply lacks the prefix).
  const salvaged = {
    ...(salvage.salvageCalls.length ? { salvageCalls: salvage.salvageCalls } : {}),
    ...(salvage.droppedCall ? { droppedCall: salvage.droppedCall } : {}),
  }
  sessions.commit({
    threadId,
    account: identity,
    session: sessionKey || '',
    keys: threadKeys(convo),
    toolNames,
    ...salvaged,
  })
}
