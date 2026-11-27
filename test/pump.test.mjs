import { test } from 'node:test'
import assert from 'node:assert/strict'
import { primeItems } from '../src/http/pump.ts'

test('header timeout preserves one pending next and items closes its source on return', async () => {
  let resolveNext
  let nextCalls = 0
  let returnCalls = 0
  const source = {
    next() {
      nextCalls++
      return new Promise((resolve) => { resolveNext = resolve })
    },
    return(value) {
      returnCalls++
      return Promise.resolve({ done: true, value })
    },
  }

  const primed = await primeItems(source, { stream: true, headerWaitMs: 15 })
  assert.equal(primed.pre.length, 0)
  assert.equal(primed.done, false)
  assert.equal(nextCalls, 1)

  const pendingItem = primed.items.next()
  await Promise.resolve()
  assert.equal(nextCalls, 1, 'continuation must reuse the outstanding next()')
  resolveNext({ done: false, value: { type: 'text', text: 'hello' } })
  assert.deepEqual(await pendingItem, { done: false, value: { type: 'text', text: 'hello' } })
  assert.deepEqual(await primed.items.return(), { done: true, value: undefined })
  assert.equal(returnCalls, 1)
})

test('header wait timer is cleared when the source next rejects', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const tracked = new Set()
  const cleared = new Set()
  const headerWaitMs = 60_000
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = realSetTimeout(callback, delay, ...args)
    if (delay === headerWaitMs) tracked.add(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    if (tracked.has(timer)) cleared.add(timer)
    return realClearTimeout(timer)
  }

  try {
    const source = {
      next: () => Promise.reject(new Error('source failed')),
      return: (value) => Promise.resolve({ done: true, value }),
    }
    await assert.rejects(primeItems(source, { stream: true, headerWaitMs }), /source failed/)
    assert.equal(tracked.size, 1)
    assert.equal(cleared.size, 1)
  } finally {
    for (const timer of tracked) realClearTimeout(timer)
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})
