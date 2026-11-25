// Quick thread reuse.
//
// Port of magpie-aws-quick-bridge's thread matcher. A thread is identified by
// the account, the client's conversation key, and the PREFIX of message keys:
//
//   - an assistant message is the wildcard "assistant" — the client resends
//     its own rendering of our reply (trimmed, split, notes, regenerated call
//     ids) and that must not look like a new conversation;
//   - user/tool messages are content hashes — if one changes (edit, rewind,
//     client-side compaction, history pruning), the prefix stops matching and
//     the request starts a new thread with the transcript it now has.
//
// There is no chain hash, no fuzzy anchor and no session-key fallback. Those
// were the fork's additions; they kept a thread alive after the client had
// already rewritten the conversation, so the model worked from history the
// client no longer had.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { textOf, canonRole } from './translate.ts'

// 24h idle TTL: real agent sessions pause far longer than 30min between turns.
export const SESSION_DEFAULTS = Object.freeze({ ttlMs: 24 * 60 * 60 * 1000, max: 200 })

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 24)
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const isSystem = (role) => role === 'system' || role === 'developer'

/** What identifies a message when a later request repeats it. */
export function messageKey(m) {
  if (!m) return ''
  const role = canonRole(m.role)
  if (isSystem(role)) return ''
  if (role === 'assistant') return 'assistant'
  return `${role}:${sha(`${m.tool_call_id ?? ''}\n${m.name ?? ''}\n${norm(textOf(m.content))}`)}`
}

/** The keys of a conversation, system messages left out. */
export function threadKeys(messages) {
  return (messages ?? []).map(messageKey).filter(Boolean)
}

export interface ThreadEntry {
  threadId: string
  account: string
  session: string
  /** Message keys including the trailing "assistant" the turn ended with. */
  keys: string[]
  toolNames: string[]
  salvageCalls?: { name: string; arguments: string }[]
  droppedCall?: { reason: string; name: string } | null
  at: number
}

export interface SessionStoreOptions {
  ttlMs?: number
  max?: number
  now?: () => number
  file?: string | null
}

/**
 * Thread-centric cache: one entry per Quick thread, keyed by threadId. A
 * request continues the longest stored prefix with the same account/session
 * whose new tail is user/tool only.
 */
export function createSessionStore({ ttlMs = SESSION_DEFAULTS.ttlMs, max = SESSION_DEFAULTS.max, now = () => Date.now(), file = null }: SessionStoreOptions = {}) {
  const threads = new Map<string, ThreadEntry>() // insertion order = LRU order
  const clean = (v: any): ThreadEntry | null => {
    if (!v || typeof v.threadId !== 'string' || typeof v.account !== 'string' || typeof v.session !== 'string') return null
    if (!Array.isArray(v.keys) || !Number.isFinite(v.at)) return null
    const keys = v.keys.filter((k) => typeof k === 'string')
    if (!keys.length) return null
    return {
      threadId: v.threadId,
      account: v.account,
      session: v.session,
      keys,
      toolNames: Array.isArray(v.toolNames) ? v.toolNames.filter((n) => typeof n === 'string') : [],
      at: v.at,
    }
  }
  const readDisk = (): ThreadEntry[] => {
    if (!file) return []
    try {
      const db = JSON.parse(readFileSync(file, 'utf8'))
      const saved = (db?.entries ?? {}) as Record<string, any>
      return Object.values(saved).map(clean).filter((e): e is ThreadEntry => !!e && now() - e.at <= ttlMs)
    } catch { return [] }
  }
  for (const e of readDisk()) threads.set(e.threadId, e)

  // Another instance may have written since we loaded (the host can
  // re-instantiate per request). The file is the source of truth on a lookup:
  // a thread another instance took is gone, so this instance cannot append to
  // it a second time.
  let lastStamp: string | null = null
  const stamp = () => {
    try { const st = statSync(file as string); return `${st.mtimeMs}:${st.size}` } catch { return null }
  }
  lastStamp = stamp()
  const refresh = () => {
    if (!file) return
    const st = stamp()
    if (!st || st === lastStamp) return
    threads.clear()
    for (const e of readDisk()) threads.set(e.threadId, e)
    lastStamp = st
  }
  const touched = new Set<string>()
  const persist = () => {
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      let disk: Record<string, any> = {}
      try {
        const db = JSON.parse(readFileSync(file, 'utf8'))
        if (db && typeof db === 'object' && db.entries && typeof db.entries === 'object') disk = db.entries
      } catch { /* missing/corrupt → start empty */ }
      const entries: Record<string, any> = { ...disk }
      for (const id of touched) {
        const t = threads.get(id)
        if (t) entries[id] = { threadId: t.threadId, account: t.account, session: t.session, keys: t.keys, toolNames: t.toolNames, at: t.at }
        else delete entries[id]
      }
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(tmp, JSON.stringify({ entries }))
      renameSync(tmp, file)
      touched.clear()
      lastStamp = stamp()
    } catch { /* best effort — the cache is an optimization */ }
  }
  const live = (t: ThreadEntry) => {
    if (now() - t.at <= ttlMs) return true
    threads.delete(t.threadId)
    touched.add(t.threadId)
    return false
  }
  const evict = () => {
    while (threads.size > max) {
      const oldest = threads.keys().next().value
      if (oldest === undefined) break
      threads.delete(oldest)
      touched.add(oldest)
    }
  }
  return {
    /**
     * The thread this request continues: same account and session, stored
     * keys a prefix of `keys`, and a new tail with no assistant message.
     * The match is removed (single-use) so two requests cannot append to one
     * thread; restore() puts it back if the turn never commits.
     */
    match({ account, session, keys }: { account: string; session: string; keys: string[] }): ThreadEntry | undefined {
      refresh()
      let best: ThreadEntry | undefined
      for (const t of threads.values()) {
        if (!live(t)) continue
        if (t.account !== account || t.session !== session) continue
        if (t.keys.length >= keys.length) continue
        if (!t.keys.every((k, i) => k === keys[i])) continue
        if (keys.slice(t.keys.length).includes('assistant')) continue
        if (!best || t.keys.length > best.keys.length) best = t
      }
      if (!best) return undefined
      threads.delete(best.threadId)
      touched.add(best.threadId)
      persist()
      return best
    },
    /** Record where the turn leaves the conversation (reply included). */
    commit(entry: Omit<ThreadEntry, 'at'>) {
      threads.delete(entry.threadId)
      threads.set(entry.threadId, { ...entry, keys: [...entry.keys, 'assistant'], at: now() })
      touched.add(entry.threadId)
      evict()
      persist()
    },
    /** Put a taken entry back after a failed/cancelled turn. */
    restore(entry: ThreadEntry) {
      if (!threads.has(entry.threadId)) {
        threads.set(entry.threadId, entry)
        touched.add(entry.threadId)
        evict()
        persist()
      }
    },
    get size() { return threads.size },
    clear() {
      for (const id of threads.keys()) touched.add(id)
      threads.clear()
      persist()
    },
  }
}
