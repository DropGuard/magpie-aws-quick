// The retry policy is pure, so every path is checkable without a socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRetry } from '../src/runtime/retry.ts'

const base = { guardTries: 0, guardMax: 1, reused: true, produced: false }

test('a guardrail with no output is retried on the same thread, then surfaced', () => {
  assert.deepEqual(nextRetry(base, { kind: 'guardrail' }), { type: 'guardrail-retry' })
  assert.deepEqual(nextRetry({ ...base, guardTries: 1 }, { kind: 'guardrail' }), { type: 'stop' })
  assert.deepEqual(nextRetry({ ...base, guardMax: 0 }, { kind: 'guardrail' }), { type: 'stop' })
})

test('a guardrail after output is never retried (it could not be retracted)', () => {
  assert.deepEqual(nextRetry({ ...base, produced: true }, { kind: 'guardrail' }), { type: 'stop' })
})

test('a dead cached thread is replaced with a fresh one carrying the transcript', () => {
  assert.deepEqual(nextRetry(base, { kind: 'stream' }), { type: 'fresh-thread-retry' })
  assert.deepEqual(nextRetry({ ...base, reused: false }, { kind: 'stream' }), { type: 'stop' })
  assert.deepEqual(nextRetry({ ...base, produced: true }, { kind: 'stream' }), { type: 'stop' })
})

test('auth trouble and watchdog timeouts are never retried in place', () => {
  assert.deepEqual(nextRetry(base, { kind: 'auth' }), { type: 'stop' })
  assert.deepEqual(nextRetry(base, { kind: 'timeout' }), { type: 'stop' })
})
