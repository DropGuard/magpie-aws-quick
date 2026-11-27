import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abortable, createCallScope } from '../src/runtime/deadline.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('scope wait uses the original fixed deadline instead of extending it', async () => {
  const scope = createCallScope({ timeoutMs: 60 })
  const startedAt = Date.now()
  try {
    await assert.rejects(scope.wait(sleep(500)), (error) => {
      assert.equal(error.kind, 'timeout')
      assert.equal(error.status, 503)
      assert.match(error.message, /requestTimeoutMs=60ms/)
      return true
    })
    assert.ok(Date.now() - startedAt < 300, 'wait should be interrupted by its original deadline')
  } finally {
    scope.dispose()
  }
})

test('scope checks elapsed time after a wait even when synchronous work delayed the timer', async () => {
  const scope = createCallScope({ timeoutMs: 10 })
  try {
    const work = Promise.resolve().then(() => {
      const end = Date.now() + 20
      while (Date.now() < end) { /* Deliberately block the timer for this regression. */ }
      return 'too late'
    })
    await assert.rejects(scope.wait(work), (error) => error.kind === 'timeout' && error.status === 503)
  } finally { scope.dispose() }
})

test('client cancellation is distinct from a scope deadline', async () => {
  const controller = new AbortController()
  const scope = createCallScope({ signal: controller.signal, timeoutMs: 1_000 })
  const pending = scope.wait(new Promise(() => {}))
  controller.abort()
  await assert.rejects(pending, (error) => {
    assert.equal(error.kind, 'abort')
    assert.equal(error.status, 499)
    return true
  })
  assert.equal(scope.normalize(new Error('ignored')).kind, 'abort')
  scope.dispose()

  const timed = createCallScope({ timeoutMs: 0 })
  assert.equal(timed.deadlineAt, null)
  assert.equal(timed.remainingMs(), Infinity)
  timed.dispose()
})

test('successful wait and dispose leave no active scope timer', async () => {
  const scope = createCallScope({ timeoutMs: 30 })
  assert.equal(await scope.wait(Promise.resolve('ok')), 'ok')
  scope.dispose()
  scope.dispose()
  await sleep(60)
  assert.equal(scope.signal.aborted, false)
})

test('abortable consumes a late rejection after cancellation, including an already-aborted signal', async () => {
  const controller = new AbortController()
  let rejectWork
  const work = new Promise((_, reject) => { rejectWork = reject })
  const pending = abortable(work, controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  rejectWork(new Error('late failure'))

  const alreadyAborted = new AbortController()
  alreadyAborted.abort(new Error('already cancelled'))
  let rejectLate
  const lateWork = new Promise((_, reject) => { rejectLate = reject })
  await assert.rejects(abortable(lateWork, alreadyAborted.signal), /already cancelled/)
  rejectLate(new Error('later failure'))
  await sleep(10)
})

test('scope.wait consumes rejection when a pre-aborted scope fails its synchronous check', async () => {
  const scope = createCallScope({ timeoutMs: 0 })
  scope.abort()
  let rejectWork
  const work = new Promise((_, reject) => { rejectWork = reject })
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    await assert.rejects(scope.wait(work), (error) => error.status === 499)
    rejectWork(new Error('late rejected work'))
    await sleep(10)
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    scope.dispose()
  }
})
