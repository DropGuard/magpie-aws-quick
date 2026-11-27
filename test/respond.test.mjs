import { test } from 'node:test'
import assert from 'node:assert/strict'
import { respondWithItems } from '../src/http/respond.ts'

const opts = (overrides = {}) => ({
  id: 'chatcmpl-test',
  created: 1,
  model: 'fake-model',
  stream: true,
  includeUsage: false,
  onError: () => {},
  onCancel: () => {},
  ...overrides,
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await tick()
  assert.ok(predicate(), 'condition should become true')
}

test('SSE failures call onError and normalize deadline status before framing', async () => {
  const original = new Error('socket aborted')
  const timeout = new Error('request deadline')
  timeout.kind = 'timeout'
  timeout.status = 503
  const errors = []
  let settled = 0
  async function* broken() {
    yield { type: 'text', text: 'partial' }
    throw original
  }

  const response = await respondWithItems(broken(), opts({
    normalizeError: (error) => error === original ? timeout : error,
    onError: (error) => errors.push(error),
    onSettled: () => settled++,
  }))
  const body = await response.text()
  const errorFrame = body.split('\n\n').map((frame) => frame.replace(/^data: /, '')).find((frame) => frame.startsWith('{"error"'))

  assert.equal(errors.length, 1)
  assert.equal(errors[0], timeout)
  assert.equal(JSON.parse(errorFrame).error.code, 503)
  assert.match(body, /data: \[DONE\]/)
  assert.equal(settled, 1)
})

test('SSE cancel waits for generator exit and cleanup before settling', async () => {
  let rejectNext
  let finishCleanup
  let onCancelCalls = 0
  let onErrorCalls = 0
  let settled = 0
  let resolveSettled
  const settledPromise = new Promise((resolve) => { resolveSettled = resolve })
  const cleanup = new Promise((resolve) => { finishCleanup = resolve })
  const items = {
    [Symbol.asyncIterator]() { return this },
    next() { return new Promise((_, reject) => { rejectNext = reject }) },
  }

  const response = await respondWithItems(items, opts({
    onError: () => { onErrorCalls++ },
    onCancel: () => { onCancelCalls++; return cleanup },
    onSettled: () => { settled++; resolveSettled() },
  }))
  const reader = response.body.getReader()
  await until(() => typeof rejectNext === 'function')

  const cancelPromise = reader.cancel()
  assert.equal(onCancelCalls, 1)
  assert.equal(settled, 0)
  rejectNext(new Error('aborted by client'))
  await until(() => onErrorCalls === 1)
  assert.equal(settled, 0, 'onSettled waits for cancel cleanup')

  finishCleanup()
  await cancelPromise
  await settledPromise
  assert.equal(settled, 1)
  assert.equal(onErrorCalls, 1)
})

test('non-stream failures also normalize and settle exactly once', async () => {
  const abort = new Error('abort')
  const timeout = new Error('request timed out')
  timeout.kind = 'timeout'
  timeout.status = 503
  let errorCalls = 0
  let settled = 0
  async function* broken() { throw abort }

  const response = await respondWithItems(broken(), opts({
    stream: false,
    normalizeError: () => timeout,
    onError: (error) => { errorCalls++; assert.equal(error, timeout) },
    onSettled: () => settled++,
  }))
  assert.equal(response.status, 503)
  assert.equal(errorCalls, 1)
  assert.equal(settled, 1)
})
