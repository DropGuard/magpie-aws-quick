// Quick thread reuse.
//
// Same problem as magpie-comate: OpenAI clients resend the whole history every
// request, while the Quick bidi socket keeps server-side history per thread_id.
// We recognise a request as the continuation of a thread we answered by hashing
// its message chain:
//
//   scope = H(account, agent_mode, system prompt, tool schemas)
//   key   = H(scope, m1, …, mk, our reply)
//
// A later request whose messages start with exactly that prefix continues the
// same Quick thread with only the messages after it. Anything else (edited or
// branched history, changed system prompt/tools/mode, expired or evicted
// entry) starts a fresh thread. Entries are claimed when used so a retry never
// replays a turn. Memory only.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { textOf, canonRole } from './translate.ts'

// 24h idle TTL: real agent sessions pause far longer than 30min between turns.
// A stale threadId is safe — the handler retries once on a fresh thread.
export const SESSION_DEFAULTS = Object.freeze({ ttlMs: 24 * 60 * 60 * 1000, max: 200 })

const sha = (s) => createHash('sha256').update(s).digest('hex')
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** Canonical form of one message, tolerant to client/gateway rewrites. */
export function canonMessage(m) {
  if (!m) return ''
  const role = canonRole(m.role)
  if (role === 'assistant') {
    // ids + names only: arguments get re-serialised; reasoning is often dropped
    const calls = (m.tool_calls || []).map((c) => `${c.id}:${c.function?.name ?? ''}`).join(',')
    return `assistant|${norm(textOf(m.content))}|${calls}`
  }
  if (role === 'tool') return `tool|${m.tool_call_id ?? m.id ?? ''}|${norm(textOf(m.content))}`
  if (m.role === 'function') return `function|${m.name ?? ''}|${norm(textOf(m.content))}`
  return `${role}|${norm(textOf(m.content))}`
}

/** Assistant message as we answered it (text + any tool calls we emitted). */
export function replyMessage(text, toolCalls) {
  const m: any = { role: 'assistant', content: text ?? '' }
  if (toolCalls?.length) {
    m.tool_calls = toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name ?? c.function?.name, arguments: c.arguments ?? c.function?.arguments ?? '{}' },
    }))
  }
  return m
}

export function sessionScope(identity, agentMode, systemText, tools) {
  return sha(`${sha(`quick:${identity}`)}|${agentMode}|${sha(norm(systemText))}|${sha(JSON.stringify(tools ?? []))}`)
}

/** h[k] = hash of the first k messages under scope (h[0] = scope). */
export function chainHashes(scope, messages) {
  const h = [scope]
  for (const m of messages) h.push(sha(`${h[h.length - 1]}\n${canonMessage(m)}`))
  return h
}

export const extendHash = (prev, m) => sha(`${prev}\n${canonMessage(m)}`)

/**
 * Fuzzy-resume anchors. Agents like pi run context extensions that prune or
 * rewrite old history, which breaks the strict prefix chain. Our own reply
 * echo plus the messages that preceded it survive such edits, so they make a
 * position-independent fingerprint: replyKey matches the echoed assistant
 * message, tailKey matches the 3 messages right before it.
 */
export const replyAnchor = (scope, reply) => sha(`${scope}|reply|${canonMessage(reply)}`)
export const tailAnchor = (scope, msgs) => sha(`${scope}|tail|${(msgs ?? []).map(canonMessage).join('\n')}`)

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]    idle expiry (default 24h)
 * @param {number} [opts.max]      LRU cap (default 200)
 * @param {Function} [opts.now]    clock override for tests
 * @param {string} [opts.file]     optional JSON file for persistence — plugin
 *   hosts may re-instantiate per request/session, which would otherwise drop
 *   every cached thread. Only hashes, threadIds, tool names and call ids are stored, never content.
 */
export function createSessionStore({ ttlMs = SESSION_DEFAULTS.ttlMs, max = SESSION_DEFAULTS.max, now = () => Date.now(), file = null }: {
  ttlMs?: number
  max?: number
  now?: () => number
  file?: string | null
} = {}) {
  const map = new Map() // key → {entry, at}; insertion order = LRU order
  if (file) {
    try {
      const db = JSON.parse(readFileSync(file, 'utf8'))
      const saved = (db?.entries ?? {}) as Record<string, any>
      for (const [k, v] of Object.entries(saved)) {
        if (v && typeof v.threadId === 'string' && Number.isFinite(v.at) && now() - v.at <= ttlMs) {
          const toolNames = Array.isArray(v.toolNames) ? v.toolNames.filter((n) => typeof n === 'string') : undefined
          map.set(k, { entry: { threadId: v.threadId, replyKey: v.replyKey, tailKey: v.tailKey, toolNames, callIds: Array.isArray(v.callIds) ? v.callIds : undefined }, at: v.at })
        }
      }
    } catch { /* missing/corrupt → start empty */ }
  }
  // Another instance may have written since we loaded (the host can
  // re-instantiate per request, and a long-lived instance would otherwise
  // never see those anchors). On a lookup MISS, re-read the file once.
  let lastStamp: string | null = null
  const stamp = () => {
    try { const st = statSync(file as string); return `${st.mtimeMs}:${st.size}` } catch { return null }
  }
  lastStamp = stamp()
  const refresh = () => {
    if (!file) return
    const st = stamp()
    if (!st || st === lastStamp) return
    try {
      const db = JSON.parse(readFileSync(file, 'utf8'))
      const saved = (db?.entries ?? {}) as Record<string, any>
      for (const [k, v] of Object.entries(saved)) {
        if (!v || typeof v.threadId !== 'string' || !Number.isFinite(v.at)) continue
        if (now() - v.at > ttlMs) continue
        const cur = map.get(k)
        if (cur && cur.at >= v.at) continue
        const toolNames = Array.isArray(v.toolNames) ? v.toolNames.filter((n) => typeof n === 'string') : undefined
        map.set(k, { entry: { threadId: v.threadId, replyKey: v.replyKey, tailKey: v.tailKey, toolNames, callIds: Array.isArray(v.callIds) ? v.callIds : undefined }, at: v.at })
      }
    } catch { /* missing/corrupt → keep memory */ }
    lastStamp = st
  }

  // Keys this instance has written or deleted since loading. A plugin host may
  // re-instantiate the store per request, so several instances share the file;
  // a full-map rewrite from a stale instance used to clobber the entries a
  // faster turn had just written (measured: 4 of 5 tool-loop turns lost their
  // anchor, so the next user message started a new thread). Persist is
  // therefore write-through and merges only OUR keys into whatever is on disk.
  const touched = new Set<string>()
  const persist = () => {
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      let disk: Record<string, any> = {}
      try {
        const db = JSON.parse(readFileSync(file, 'utf8'))
        if (db && typeof db === 'object' && db.entries && typeof db.entries === 'object') disk = db.entries
      } catch { /* missing/corrupt → start from empty */ }
      const entries: Record<string, any> = { ...disk }
      for (const k of touched) {
        const v = map.get(k)
        if (v) entries[k] = { threadId: v.entry.threadId, at: v.at, replyKey: v.entry.replyKey, tailKey: v.entry.tailKey, toolNames: v.entry.toolNames, callIds: v.entry.callIds }
        else delete entries[k]
      }
      // Unique tmp name: two plugin instances (a chat turn and a background
      // request) share this file, and a shared tmp path loses one of the two
      // writes on rename.
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(tmp, JSON.stringify({ entries }))
      renameSync(tmp, file)
      touched.clear()
      lastStamp = stamp()
    } catch { /* best effort — cache is an optimization */ }
  }
  const live = (key) => {
    const v = map.get(key)
    if (!v) return undefined
    if (now() - v.at > ttlMs) { map.delete(key); touched.add(key); return undefined }
    return v
  }
  const findEntryIn = (pred) => {
    for (const [key, v] of map) {
      if (now() - v.at > ttlMs) { map.delete(key); touched.add(key); continue }
      if (pred(v.entry)) return { key, entry: v.entry }
    }
    return undefined
  }
  return {
    has(key) {
      if (live(key)) return true
      refresh()
      return !!live(key)
    },
    /** First live entry matching pred → {key, entry}; does not remove it. */
    findEntry(pred) {
      const hit = findEntryIn(pred)
      if (hit) return hit
      refresh()
      return findEntryIn(pred)
    },
    take(key) {
      let v = live(key)
      if (!v) { refresh(); v = live(key) }
      if (!v) return undefined
      map.delete(key)
      touched.add(key)
      persist()
      return v.entry
    },
    set(key, entry) {
      map.delete(key)
      map.set(key, { entry, at: now() })
      touched.add(key)
      while (map.size > max) { const oldest = map.keys().next().value; map.delete(oldest); touched.add(oldest) }
      persist()
    },
    get size() { return map.size },
    clear() { for (const k of map.keys()) touched.add(k); map.clear(); persist() },
  }
}

/**
 * Find the newest cached thread state that this conversation extends.
 * @returns {{index:number, entry:object, delta:Array}|undefined}
 */
export function findContinuation(store, hashes, convo) {
  for (let i = convo.length - 1; i >= 1; i--) {
    if (canonRole(convo[i - 1]?.role) !== 'assistant') continue
    if (!store.has(hashes[i])) continue
    const delta = convo.slice(i)
    // only new user turns / tool results can be appended to server-side history
    if (!delta.length || delta.some((m) => !['user', 'tool', 'function'].includes(canonRole(m.role)))) return undefined
    const entry = store.take(hashes[i])
    return entry ? { index: i, key: hashes[i], entry, delta } : undefined
  }
  return undefined
}
