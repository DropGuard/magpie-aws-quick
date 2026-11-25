import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSessionStore, messageKey, threadKeys } from '../src/sessions.ts'

const user = (text) => ({ role: 'user', content: text })
const asst = (text = 'reply') => ({ role: 'assistant', content: text })
const tool = (id, text) => ({ role: 'tool', tool_call_id: id, name: 'Read', content: text })

test('messageKey: assistant is a wildcard, user/tool are content hashes', () => {
  assert.equal(messageKey(asst('one')), 'assistant')
  assert.equal(messageKey(asst('two')), 'assistant')
  assert.equal(messageKey({ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] }), 'assistant')
  assert.notEqual(messageKey(user('a')), messageKey(user('b')))
  assert.notEqual(messageKey(tool('c1', 'a')), messageKey(tool('c1', 'b')))
  assert.equal(messageKey({ role: 'system', content: 'rules' }), '')
  assert.equal(messageKey({ role: 'developer', content: 'rules' }), '')
})

test('threadKeys leaves system messages out and keeps the assistant placeholder', () => {
  const keys = threadKeys([
    { role: 'system', content: 'rules' },
    user('hi'),
    asst('hello'),
    tool('c1', 'result'),
  ])
  assert.equal(keys.length, 3)
  assert.equal(keys[1], 'assistant')
})

test('a thread continues when the client appends user/tool turns', () => {
  const store = createSessionStore()
  const turn1 = [user('hi')]
  store.commit({ threadId: 't1', account: 'acct', session: 's', keys: threadKeys(turn1), toolNames: [] })

  const turn2 = [user('hi'), asst('hello'), user('next')]
  const hit = store.match({ account: 'acct', session: 's', keys: threadKeys(turn2) })
  assert.ok(hit)
  assert.equal(hit.threadId, 't1')
  assert.equal(hit.keys.length, 2) // user + assistant
  assert.deepEqual(turn2.slice(hit.keys.length), [user('next')])
})

test('a rewritten assistant reply does not break the thread', () => {
  const store = createSessionStore()
  store.commit({ threadId: 't1', account: 'acct', session: 's', keys: threadKeys([user('hi')]), toolNames: [] })
  const convo = [user('hi'), asst('a completely rewritten reply'), user('next')]
  const hit = store.match({ account: 'acct', session: 's', keys: threadKeys(convo) })
  assert.ok(hit)
  assert.equal(hit.threadId, 't1')
})

test('edited user/tool history starts a new thread', () => {
  const store = createSessionStore()
  store.commit({ threadId: 't1', account: 'acct', session: 's', keys: threadKeys([user('hi')]), toolNames: [] })
  const edited = [user('hi EDITED'), asst('hello'), user('next')]
  assert.equal(store.match({ account: 'acct', session: 's', keys: threadKeys(edited) }), undefined)
})

test('a tail containing an assistant message cannot be appended', () => {
  const store = createSessionStore()
  store.commit({ threadId: 't1', account: 'acct', session: 's', keys: threadKeys([user('hi')]), toolNames: [] })
  const forked = [user('hi'), asst('hello'), asst('another'), user('next')]
  assert.equal(store.match({ account: 'acct', session: 's', keys: threadKeys(forked) }), undefined)
})

test('account and session must match', () => {
  const store = createSessionStore()
  store.commit({ threadId: 't1', account: 'acct', session: 's', keys: threadKeys([user('hi')]), toolNames: [] })
  const keys = threadKeys([user('hi'), asst('hello'), user('next')])
  assert.equal(store.match({ account: 'other', session: 's', keys }), undefined)
  assert.equal(store.match({ account: 'acct', session: 'other', keys }), undefined)
  assert.ok(store.match({ account: 'acct', session: 's', keys }))
})

test('a match is single-use and restore() puts it back', () => {
  const store = createSessionStore()
  store.commit({ threadId: 't1', account: 'acct', session: 's', keys: threadKeys([user('hi')]), toolNames: [] })
  const keys = threadKeys([user('hi'), asst('hello'), user('next')])
  const hit = store.match({ account: 'acct', session: 's', keys })
  assert.ok(hit)
  assert.equal(store.match({ account: 'acct', session: 's', keys }), undefined)
  store.restore(hit)
  assert.ok(store.match({ account: 'acct', session: 's', keys }))
})

test('the longest stored prefix wins', () => {
  const store = createSessionStore()
  store.commit({ threadId: 'short', account: 'acct', session: 's', keys: threadKeys([user('hi')]), toolNames: [] })
  const longer = [user('hi'), asst('a'), user('q1')] // the request it answered ends with a user turn
  store.commit({ threadId: 'long', account: 'acct', session: 's', keys: threadKeys(longer), toolNames: [] })
  const hit = store.match({ account: 'acct', session: 's', keys: threadKeys([...longer, asst('b'), user('q2')]) })
  assert.equal(hit.threadId, 'long')
})

test('the cache persists and a fresh instance resumes it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'magpie-threads-'))
  const file = path.join(dir, 'thread-sessions.json')
  try {
    const a = createSessionStore({ file })
    a.commit({ threadId: 't1', account: 'acct', session: 's', keys: threadKeys([user('hi')]), toolNames: ['Read'] })
    const b = createSessionStore({ file }) // host re-instantiated
    const hit = b.match({ account: 'acct', session: 's', keys: threadKeys([user('hi'), asst('hello'), user('next')]) })
    assert.ok(hit)
    assert.equal(hit.threadId, 't1')
    assert.deepEqual(hit.toolNames, ['Read'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a restored thread is visible to a later instance', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'magpie-threads-'))
  const file = path.join(dir, 'thread-sessions.json')
  try {
    const a = createSessionStore({ file })
    a.commit({ threadId: 't1', account: 'acct', session: 's', keys: threadKeys([user('hi')]), toolNames: [] })
    const b = createSessionStore({ file })
    const keys = threadKeys([user('hi'), asst('hello'), user('next')])
    const hit = b.match({ account: 'acct', session: 's', keys })
    assert.ok(hit)
    b.restore(hit)
    const c = createSessionStore({ file })
    assert.ok(c.match({ account: 'acct', session: 's', keys }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
