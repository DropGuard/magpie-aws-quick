import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { setTimeout as delay, setImmediate as nextTick } from 'node:timers/promises'
import { handleChatCompletions, INVALID_CALL_TOOL } from '../src/handler.ts'
import { createSessionStore } from '../src/sessions.ts'
import { createCallScope, DEFAULT_CALL_TIMEOUT_MS } from '../src/runtime/deadline.ts'
import { createProxyServer } from '../bin/serve.mjs'
import { startFakeQuick, defaultScript } from './helpers/fake-quick.ts'

// All network traffic stays on loopback. Gates deliberately ignore cancellation:
// even a dependency completing after its caller left must not send or commit.
const TEST = { timeout: 6_000 }
const user = (content) => ({ role: 'user', content })
const assistant = (content) => ({ role: 'assistant', content })
const chat = (messages, extra = {}) => ({ model: 'fast', messages, ...extra })
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

async function bounded(promise, label, ms = 1_500) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms) }),
    ])
  } finally { clearTimeout(timer) }
}

async function until(predicate, label, ms = 1_000) {
  const end = Date.now() + ms
  while (!predicate()) {
    assert.ok(Date.now() < end, `timed out waiting for ${label}`)
    await delay(5)
  }
}

function sse(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const line = block.split(/\r?\n/).find((part) => part.startsWith('data: '))
    if (!line) return []
    const data = line.slice(6)
    return [data === '[DONE]' ? data : JSON.parse(data)]
  })
}

async function assertTimeout(response) {
  assert.equal(response.status, 503)
  assert.match(response.headers.get('content-type'), /application\/json/)
  const body = await bounded(response.json(), 'timeout JSON')
  assert.equal(body.error.code, 503)
  assert.match(body.error.message, /requestTimeoutMs/, 'must be the whole-call deadline, not the idle watchdog')
}

async function fixture(t, { script } = {}) {
  const fake = await startFakeQuick({ script })
  const store = createSessionStore()
  const audit = { taken: [], commits: [], restores: [] }
  const sessions = {
    match(input) {
      const entry = store.match(input)
      if (entry) audit.taken.push(entry)
      return entry
    },
    commit(entry) { audit.commits.push({ ...entry }); store.commit(entry) },
    restore(entry) { audit.restores.push(entry); store.restore(entry) },
    get size() { return store.size },
  }
  const outpost = {
    outpostId: async () => 'lifecycle-device',
    session: async () => ({ ws_host: fake.wsHost, id_token: 'fake-token', usable_until: Math.floor(Date.now() / 1_000) + 600 }),
  }
  // Keep this exact object: the handler caches one multiplexed socket per outpost.
  const outpostMgr = { ensure: async () => outpost }
  const gates = [], controllers = [], scopes = [], responses = [], servers = []
  const options = { identity: 'lifecycle-fake', log: () => {}, requestTimeoutMs: 1_500, idleTimeoutMs: 3_000 }
  const h = {
    fake, sessions, audit, outpost, outpostMgr, running: true,
    gate() { const gate = deferred(); gates.push(gate); return gate },
    controller() { const controller = new AbortController(); controllers.push(controller); return controller },
    scope(timeoutMs) { const scope = createCallScope({ timeoutMs }); scopes.push(scope); return scope },
    call(messages, { body = {}, options: overrides = {}, ...args } = {}) {
      const pending = handleChatCompletions({ body: chat(messages, body), outpostMgr, sessions, options: { ...options, ...overrides }, ...args })
      pending.then((response) => { responses.push(response) }, () => {})
      return pending
    },
    upload(url) {
      const u = new URL(url)
      assert.equal(u.origin, `http://${new URL(fake.wsHost).host}`, 'attachment stub must only receive fake-local URLs')
      if (u.pathname.endsWith('/upload-attachment')) return json({ attachmentId: 'fake-attachment' })
      if (u.pathname.endsWith('/attachment-dlp-status')) return json({ dlpJobStatus: 'COMPLETED', policyAction: 'ALLOW' })
      if (u.pathname.endsWith('/qbs-event')) return json({ eventResponse: { invokeAgentResponse: { api_response: { status: 200, body: { path: '/data/attached_files/fake.png' } } } } })
      assert.fail(`unexpected attachment route: ${u.pathname}`)
    },
    async proxy(overrides = {}) {
      const server = createProxyServer({ outpostMgr, sessions, options: { ...options, ...overrides } })
      servers.push(server)
      await bounded(new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
      }), 'proxy listen')
      return `http://127.0.0.1:${server.address().port}/v1/chat/completions`
    },
  }
  t.after(async () => {
    h.running = false
    for (const controller of controllers) controller.abort()
    for (const scope of scopes) { scope.abort(); scope.dispose() }
    for (const response of responses) {
      if (response.body && !response.bodyUsed && !response.body.locked) {
        await bounded(response.body.cancel(), 'response cleanup', 500).catch(() => {})
      }
    }
    for (const gate of gates) gate.resolve()
    for (const server of servers) {
      server.closeAllConnections()
      await bounded(new Promise((resolve) => server.close(resolve)), 'proxy close')
    }
    await bounded(fake.close(), 'fake close')
  })
  return h
}

async function seed(h, text = 'remember lifecycle seed') {
  const first = user(text)
  const response = await bounded(h.call([first]), 'seed turn')
  assert.equal(response.status, 200)
  const reply = (await response.json()).choices[0].message.content
  return { first, reply, threadId: h.fake.state.userMessages.at(-1).threadId }
}

const imageUser = () => user([
  { type: 'text', text: 'inspect this lifecycle image' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.alloc(80 * 1_024, 7).toString('base64')}` } },
])

test('lifecycle: default scope is ten minutes; requestTimeoutMs=0 leaves a gated turn alive', TEST, async (t) => {
  assert.equal(DEFAULT_CALL_TIMEOUT_MS, 600_000)
  const defaultScope = createCallScope()
  try { assert.equal(defaultScope.timeoutMs, 600_000) } finally { defaultScope.dispose() }
  const h = await fixture(t, { script: async function* (payload) {
    yield { type: 'message_start', payload: { message_id: payload.message_id } }
    await release.promise
    yield* defaultScript(payload)
  } })
  const release = h.gate()
  let settled = false
  const pending = h.call([user('disabled request deadline')], { options: { requestTimeoutMs: 0 } }).then((response) => { settled = true; return response })
  await until(() => h.fake.state.userMessages.length === 1, 'disabled-deadline turn to send')
  await delay(60)
  assert.equal(settled, false, 'zero must not create an immediate timeout')
  release.resolve()
  const response = await bounded(pending, 'deadline-disabled completion')
  assert.equal(response.status, 200)
  await response.json()
  assert.equal(h.audit.commits.length, 1)
  assert.equal(h.fake.state.stopGenerations.length, 0)
})

test('lifecycle: synchronous planning failure restores the lease before context can be returned', TEST, async (t) => {
  const h = await fixture(t)
  const initial = await seed(h)
  const messages = [initial.first, assistant(initial.reply), user('next planning turn')]
  const match = h.sessions.match
  let fail = true
  h.sessions.match = (input) => {
    const entry = match(input)
    if (entry && fail) Object.defineProperty(entry, 'toolNames', {
      configurable: true,
      get() {
        if (fail) { fail = false; throw new Error('controlled synchronous planning failure') }
        return []
      },
    })
    return entry
  }
  const response = await bounded(h.call(messages), 'synchronous planning failure')
  assert.equal(response.status, 502)
  assert.match((await response.json()).error.message, /controlled synchronous planning failure/)
  assert.equal(h.audit.taken.length, 1)
  assert.deepEqual(h.audit.restores.map((entry) => entry.threadId), [initial.threadId])
  assert.equal(h.fake.state.userMessages.length, 1)
  const retried = await bounded(h.call(messages), 'retry after synchronous planning failure')
  assert.equal(retried.status, 200)
  await retried.json()
  assert.equal(h.fake.state.userMessages.at(-1).threadId, initial.threadId)
})

test('lifecycle: prepare failure restores a taken prefix before any user_message is sent', TEST, async (t) => {
  const h = await fixture(t)
  const initial = await seed(h)
  const messages = [initial.first, assistant(initial.reply), imageUser()]
  const session = h.outpost.session
  h.outpost.session = async () => { throw new Error('controlled preparation failure') }
  const response = await bounded(h.call(messages, { options: { fetchImpl: h.upload } }), 'failed preparation')
  assert.equal(response.status, 502)
  assert.match((await response.json()).error.message, /controlled preparation failure/)
  assert.equal(h.audit.taken.length, 1, 'must actually exercise a leased prefix')
  assert.deepEqual(h.audit.restores.map((entry) => entry.threadId), [initial.threadId])
  assert.equal(h.sessions.size, 1)
  assert.equal(h.fake.state.userMessages.length, 1)
  assert.equal(h.fake.state.stopGenerations.length, 0, 'nothing was sent to stop')
  h.outpost.session = session
  const retried = await bounded(h.call(messages, { options: { fetchImpl: h.upload } }), 'retry after preparation failure')
  assert.equal(retried.status, 200)
  await retried.json()
  assert.equal(h.fake.state.userMessages.at(-1).threadId, initial.threadId)
})

test('lifecycle: cancellation after send invalidates taken history and rejects late completion', TEST, async (t) => {
  let turns = 0
  const h = await fixture(t, { script: async function* (payload) {
    if (++turns === 2) {
      yield { type: 'message_start', payload: { message_id: payload.message_id } }
      await release.promise
      yield* defaultScript(payload)
      lateFlushed.resolve()
    } else yield* defaultScript(payload)
  } })
  const release = h.gate(), lateFlushed = h.gate()
  const initial = await seed(h)
  const messages = [initial.first, assistant(initial.reply), user('cancel this sent turn')]
  const controller = h.controller()
  const pending = h.call(messages, { signal: controller.signal })
  await until(() => h.fake.state.userMessages.length === 2, 'cancelled turn to send')
  controller.abort()
  const response = await bounded(pending, 'client cancellation', 700)
  assert.equal(response.status, 499)
  assert.equal((await response.json()).error.code, 499)
  await until(() => h.fake.state.stopGenerations.length === 1, 'thread-local cancellation stop')
  assert.equal(h.fake.state.stopGenerations[0].thread_id, initial.threadId)
  assert.equal(h.audit.restores.length, 0, 'a stop frame cannot roll server history back')
  assert.equal(h.sessions.size, 0)
  release.resolve()
  await bounded(lateFlushed.promise, 'late cancelled events')
  const retried = await bounded(h.call(messages), 'fresh retry after cancellation')
  assert.equal(retried.status, 200)
  await retried.json() // A successful same-socket turn also drains the late WS frames.
  assert.notEqual(h.fake.state.userMessages.at(-1).threadId, initial.threadId)
  assert.deepEqual(h.audit.commits.map((entry) => entry.threadId), [initial.threadId, h.fake.state.userMessages.at(-1).threadId])
  assert.equal(h.audit.restores.length, 0)
})

test('lifecycle: upstream disconnect after send never restores the taken prefix', TEST, async (t) => {
  let turns = 0
  const h = await fixture(t, { script: (payload) => ++turns === 2 ? [] : defaultScript(payload) })
  const initial = await seed(h)
  const pending = h.call([initial.first, assistant(initial.reply), user('disconnect this sent turn')], { options: { maxTurnAttempts: 1 } })
  await until(() => h.fake.state.userMessages.length === 2, 'disconnect turn to send')
  await h.fake.close()
  const response = await bounded(pending, 'upstream disconnect', 700)
  assert.equal(response.status, 502)
  await response.json()
  assert.equal(h.audit.taken.length, 1)
  assert.equal(h.audit.restores.length, 0)
  assert.equal(h.audit.commits.length, 1)
  assert.equal(h.sessions.size, 0)
})

test('lifecycle: body.cancel without an original signal stops generation and forbids late commit', TEST, async (t) => {
  let turns = 0
  const h = await fixture(t, { script: async function* (payload) {
    if (++turns === 2) {
      yield { type: 'message_start', payload: { message_id: payload.message_id } }
      await release.promise
      yield* defaultScript(payload)
      lateFlushed.resolve()
    } else yield* defaultScript(payload)
  } })
  const release = h.gate(), lateFlushed = h.gate()
  const initial = await seed(h)
  const messages = [initial.first, assistant(initial.reply), user('cancel the response body')]
  // Deliberately pass neither signal nor callScope: body cancellation must own one.
  const response = await bounded(h.call(messages, { body: { stream: true }, options: { headerWaitMs: 15 } }), 'early streaming headers')
  assert.equal(response.status, 200)
  await until(() => h.fake.state.userMessages.length === 2, 'body-cancel turn to send')
  await bounded(response.body.cancel('consumer disconnected'), 'body.cancel cleanup', 700)
  await until(() => h.fake.state.stopGenerations.length === 1, 'body.cancel stop_generation', 700)
  assert.equal(h.fake.state.stopGenerations[0].thread_id, initial.threadId)
  assert.equal(h.audit.restores.length, 0)
  assert.equal(h.sessions.size, 0)
  release.resolve()
  await bounded(lateFlushed.promise, 'late body-cancel events')
  const retried = await bounded(h.call(messages), 'retry after body.cancel')
  assert.equal(retried.status, 200)
  await retried.json()
  const fresh = h.fake.state.userMessages.at(-1).threadId
  assert.notEqual(fresh, initial.threadId)
  assert.deepEqual(h.audit.commits.map((entry) => entry.threadId), [initial.threadId, fresh])
  assert.equal(h.audit.restores.length, 0)
})

test('lifecycle: a supplied scope times out before headers as a plain Error with HTTP 503', TEST, async (t) => {
  const h = await fixture(t, { script: async function* (payload) {
    yield { type: 'message_start', payload: { message_id: payload.message_id } }
    await release.promise
    yield* defaultScript(payload)
  } })
  const release = h.gate()
  const scope = h.scope(160)
  const response = await bounded(h.call([user('scope deadline before headers')], {
    body: { stream: true }, callScope: scope, options: { requestTimeoutMs: 0, headerWaitMs: 1_000 },
  }), 'scope deadline before headers', 800)
  await assertTimeout(response)
  assert.ok(scope.signal.reason instanceof Error)
  assert.equal(scope.signal.reason.kind, 'timeout')
  assert.equal(scope.signal.reason.status, 503)
  assert.equal(h.fake.state.userMessages.length, 1)
  await until(() => h.fake.state.stopGenerations.length === 1, 'deadline stop')
  assert.equal(h.audit.commits.length, 0)
  assert.equal(h.sessions.size, 0)
})

for (const transport of ['handler', 'http']) {
  test(`lifecycle: ${transport} fixed deadline beats continuous reasoning; SSE error 503 then DONE`, TEST, async (t) => {
    const h = await fixture(t, { script: async function* (payload) {
      yield { type: 'message_start', payload: { message_id: payload.message_id } }
      while (h.running) {
        await delay(20)
        yield { type: 'thinking_delta', payload: { delta: 'still thinking ' } }
      }
    } })
    const timeoutMs = 240
    const options = { requestTimeoutMs: timeoutMs, idleTimeoutMs: 2_000, headerWaitMs: 1_000 }
    const url = transport === 'http' ? await h.proxy(options) : null
    const started = Date.now()
    const response = await bounded(transport === 'http'
      ? fetch(url, { method: 'POST', body: JSON.stringify(chat([user('keep reasoning')], { stream: true })), signal: AbortSignal.timeout(1_500) })
      : h.call([user('keep reasoning')], { body: { stream: true }, options }), 'reasoning response headers', 900)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const events = sse(await bounded(response.text(), 'fixed reasoning deadline', 900))
    h.running = false
    assert.ok(events.filter((event) => event.choices?.[0]?.delta?.reasoning_content).length >= 2, 'reasoning must really arrive at separate times')
    const errors = events.filter((event) => event.error)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].error.code, 503)
    assert.match(errors[0].error.message, /requestTimeoutMs/)
    assert.equal(events.at(-1), '[DONE]')
    assert.equal(events.filter((event) => event === '[DONE]').length, 1)
    assert.equal(events.some((event) => event.choices?.[0]?.finish_reason), false, 'a timed-out turn must not claim successful completion')
    assert.ok(Date.now() - started < 1_100, 'progress must not reset the overall deadline')
    await until(() => h.fake.state.stopGenerations.length === 1, 'reasoning deadline stop')
    assert.equal(h.fake.state.userMessages.length, 1, 'timeouts do not retry')
    assert.equal(h.audit.commits.length, 0)
  })
}

test('lifecycle: HTTP timeout while waiting for first output is a real JSON 503', TEST, async (t) => {
  const h = await fixture(t, { script: () => [] })
  const url = await h.proxy({ requestTimeoutMs: 160, headerWaitMs: 1_000 })
  const response = await bounded(fetch(url, {
    method: 'POST', body: JSON.stringify(chat([user('silent before HTTP headers')], { stream: true })), signal: AbortSignal.timeout(1_500),
  }), 'HTTP pre-header timeout', 800)
  await assertTimeout(response)
  await until(() => h.fake.state.stopGenerations.length === 1, 'HTTP pre-header stop')
  assert.equal(h.audit.commits.length, 0)
})

const retryTool = { type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }
const retryCases = [
  { name: 'default three: guard -> empty -> malformed', limit: undefined, kinds: ['guard', 'empty', 'malformed', 'success'], count: 3, final: 'malformed' },
  { name: 'two: malformed -> guard', limit: 2, kinds: ['malformed', 'guard', 'success'], count: 2, final: 'guard' },
  { name: 'two: guard -> empty', limit: 2, kinds: ['guard', 'empty', 'success'], count: 2, final: 'empty' },
  { name: 'one: empty cannot retry', limit: 1, kinds: ['empty', 'success'], count: 1, final: 'empty' },
  { name: 'four: all three recovery paths can reach success', limit: 4, kinds: ['guard', 'empty', 'malformed', 'success'], count: 4, final: 'success' },
]
for (const scenario of retryCases) {
  test(`lifecycle: shared maxTurnAttempts — ${scenario.name}`, TEST, async (t) => {
    let turn = 0
    const h = await fixture(t, { script: async function* (payload) {
      const kind = scenario.kinds[turn++] ?? 'success'
      await nextTick()
      yield { type: 'message_start', payload: { message_id: payload.message_id } }
      if (kind === 'guard') yield { type: 'guardrail_blocked', payload: { message: 'That content did not pass our automated check.' } }
      else if (kind === 'empty') {
        yield { type: 'thinking_delta', payload: { delta: 'thinking without an answer' } }
        yield { type: 'message_complete', payload: { text: '' } }
      } else if (kind === 'malformed') {
        yield { type: 'text_delta', payload: { delta: '<invoke name="Bash"><parameter name="command">echo "hi"</invoke>' } }
        yield { type: 'message_complete', payload: { text: '' } }
      } else {
        yield { type: 'text_delta', payload: { delta: 'ONLY_AFTER_ALL_RECOVERY_PATHS' } }
        yield { type: 'message_complete', payload: { text: 'ONLY_AFTER_ALL_RECOVERY_PATHS' } }
      }
    } })
    const options = { guardrailRetries: 10, answerRetries: 10, callRetries: 10 }
    if (scenario.limit !== undefined) options.maxTurnAttempts = scenario.limit
    const response = await bounded(h.call([user('exercise mixed retries')], { body: { tools: [retryTool] }, options }), 'mixed-retry budget')
    const body = await response.json()
    assert.equal(h.fake.state.userMessages.length, scenario.count, 'attempt budget is shared, not replenished per failure kind')
    assert.equal(new Set(h.fake.state.userMessages.map((message) => message.threadId)).size, 1)
    assert.equal(new Set(h.fake.state.userMessages.map((message) => message.payload.message_id)).size, scenario.count)
    if (scenario.final === 'guard' || scenario.final === 'empty') {
      assert.equal(response.status, 502)
      assert.ok(body.error)
      assert.equal(h.audit.commits.length, 0)
    } else {
      assert.equal(response.status, 200)
      assert.equal(h.audit.commits.length, 1)
      if (scenario.final === 'malformed') assert.equal(body.choices[0].message.tool_calls[0].function.name, INVALID_CALL_TOOL)
    }
    assert.equal(JSON.stringify(body).includes('ONLY_AFTER_ALL_RECOVERY_PATHS'), scenario.final === 'success')
    if (scenario.count >= 3) {
      assert.match(h.fake.state.userMessages[1].payload.text, /exercise mixed retries/)
      assert.match(h.fake.state.userMessages[2].payload.text, /without writing any answer/)
    }
  })
}

test('lifecycle: timeout awaiting ensure returns before release and cannot send or commit later', TEST, async (t) => {
  const h = await fixture(t)
  const entered = h.gate(), release = h.gate(), returned = h.gate()
  const ensure = h.outpostMgr.ensure
  let calls = 0
  h.outpostMgr.ensure = async () => {
    if (++calls === 1) { entered.resolve(); await release.promise; returned.resolve() }
    return ensure()
  }
  const pending = h.call([user('expired while ensuring')], { options: { requestTimeoutMs: 160 } })
  await bounded(entered.promise, 'ensure entered')
  await assertTimeout(await bounded(pending, 'timeout before ensure finishes', 800))
  assert.equal(h.fake.state.connections, 0)
  assert.equal(h.fake.state.userMessages.length, 0)
  assert.equal(h.audit.commits.length, 0)
  release.resolve()
  await bounded(returned.promise, 'late ensure return')
  const response = await bounded(h.call([user('live after ensure timeout')]), 'healthy ensure barrier')
  assert.equal(response.status, 200)
  await response.json()
  assert.equal(h.fake.state.userMessages.length, 1, 'expired ensure must not launch a late user_message')
  assert.match(h.fake.state.userMessages[0].payload.text, /live after ensure timeout/)
  assert.equal(h.audit.commits.length, 1)
})

test('lifecycle: timeout awaiting upload restores taken history; late upload cannot send or commit', TEST, async (t) => {
  const h = await fixture(t)
  const initial = await seed(h)
  const entered = h.gate(), release = h.gate(), returned = h.gate()
  let firstUpload = true, uploadSignal
  const fetchImpl = async (url, init) => {
    if (String(url).includes('upload-attachment') && firstUpload) {
      firstUpload = false
      uploadSignal = init.signal
      entered.resolve()
      await release.promise // Intentionally ignore the fetch signal to simulate late I/O.
      returned.resolve()
    }
    return h.upload(url)
  }
  const messages = [initial.first, assistant(initial.reply), imageUser()]
  const pending = h.call(messages, { options: { requestTimeoutMs: 160, fetchImpl } })
  await bounded(entered.promise, 'upload entered')
  await assertTimeout(await bounded(pending, 'timeout before upload finishes', 800))
  assert.equal(uploadSignal.aborted, true)
  assert.equal(h.audit.taken.length, 1)
  assert.deepEqual(h.audit.restores.map((entry) => entry.threadId), [initial.threadId])
  assert.equal(h.fake.state.userMessages.length, 1)
  assert.equal(h.fake.state.stopGenerations.length, 0)
  assert.equal(h.audit.commits.length, 1)
  release.resolve()
  await bounded(returned.promise, 'late upload return')
  const retried = await bounded(h.call(messages, { options: { fetchImpl } }), 'healthy upload barrier')
  assert.equal(retried.status, 200)
  await retried.json()
  assert.equal(h.fake.state.userMessages.length, 2, 'only the successful retry may send')
  assert.equal(h.fake.state.userMessages[1].threadId, initial.threadId)
  assert.equal(h.audit.commits.length, 2, 'no commit from the abandoned composition')
})

test('lifecycle: timeout awaiting shared connect never sends late and does not kill a live sibling', TEST, async (t) => {
  const h = await fixture(t)
  const entered = h.gate(), release = h.gate()
  const session = h.outpost.session
  h.outpost.session = async () => { entered.resolve(); await release.promise; return session() }
  const pending = h.call([user('expired during shared connect')], { options: { requestTimeoutMs: 160 } })
  await bounded(entered.promise, 'connection session entered')
  await assertTimeout(await bounded(pending, 'timeout before connect finishes', 800))
  assert.equal(h.fake.state.userMessages.length, 0)
  assert.equal(h.audit.commits.length, 0)
  const live = h.call([user('live on the shared connect')])
  release.resolve()
  const response = await bounded(live, 'live sibling connection')
  assert.equal(response.status, 200)
  await response.json()
  assert.equal(h.fake.state.connections, 1)
  assert.equal(h.fake.state.userMessages.length, 1)
  assert.match(h.fake.state.userMessages[0].payload.text, /live on the shared connect/)
  assert.equal(h.audit.commits.length, 1)
  assert.equal(h.fake.state.stopGenerations.length, 0, 'an unsent thread needs no stop and must not close the shared socket')
})

test('lifecycle: cancelling one active socket thread leaves the sibling and its cache intact', TEST, async (t) => {
  const h = await fixture(t, { script: async function* (payload) {
    yield { type: 'message_start', payload: { message_id: payload.message_id } }
    if (payload.text === 'CANCELLED_THREAD') {
      await cancelledRelease.promise
      yield* defaultScript(payload)
      cancelledFlushed.resolve()
    } else {
      if (payload.text === 'LIVE_THREAD') await liveRelease.promise
      yield* defaultScript(payload)
    }
  } })
  const cancelledRelease = h.gate(), cancelledFlushed = h.gate(), liveRelease = h.gate()
  // Establish the cached socket first; this test is about multiplexed turns,
  // not the separate cold socketFor() creation race.
  const warm = await seed(h, 'warm shared socket')
  const controller = h.controller()
  const cancelled = h.call([user('CANCELLED_THREAD')], { signal: controller.signal })
  let liveSettled = false
  const live = h.call([user('LIVE_THREAD')]).then((response) => { liveSettled = true; return response })
  await until(() => h.fake.state.userMessages.length === 3, 'both multiplexed turns to send after warm-up')
  assert.equal(h.fake.state.connections, 1)
  const cancelledThread = h.fake.state.userMessages.find((message) => message.payload.text === 'CANCELLED_THREAD').threadId
  const liveThread = h.fake.state.userMessages.find((message) => message.payload.text === 'LIVE_THREAD').threadId
  assert.notEqual(cancelledThread, liveThread)
  controller.abort()
  assert.equal((await bounded(cancelled, 'one-thread cancellation', 700)).status, 499)
  await until(() => h.fake.state.stopGenerations.length === 1, 'cancelled thread stop')
  assert.equal(h.fake.state.stopGenerations[0].thread_id, cancelledThread)
  assert.equal(liveSettled, false, 'a sibling must still be waiting, not failed by socket shutdown')
  liveRelease.resolve()
  const response = await bounded(live, 'sibling completion')
  assert.equal(response.status, 200)
  const reply = (await response.json()).choices[0].message.content
  cancelledRelease.resolve()
  await bounded(cancelledFlushed.promise, 'cancelled sibling late frames')
  const follow = await bounded(h.call([user('LIVE_THREAD'), assistant(reply), user('live sibling follow-up')]), 'sibling cache continuation')
  assert.equal(follow.status, 200)
  await follow.json()
  assert.equal(h.fake.state.userMessages.at(-1).threadId, liveThread)
  assert.deepEqual(h.audit.commits.map((entry) => entry.threadId), [warm.threadId, liveThread, liveThread])
  assert.equal(h.audit.restores.length, 0)
  assert.equal(h.fake.state.connections, 1)
  assert.equal(h.fake.state.stopGenerations.length, 1)
})

test('lifecycle: real HTTP client disconnect after send invalidates a reused prefix', TEST, async (t) => {
  let turns = 0
  const h = await fixture(t, { script: async function* (payload) {
    if (++turns === 2) {
      yield { type: 'message_start', payload: { message_id: payload.message_id } }
      yield { type: 'thinking_delta', payload: { delta: 'waiting for the HTTP client' } }
      await release.promise
      yield* defaultScript(payload)
      lateFlushed.resolve()
    } else yield* defaultScript(payload)
  } })
  const release = h.gate(), lateFlushed = h.gate()
  const initial = await seed(h)
  const messages = [initial.first, assistant(initial.reply), user('disconnect HTTP after send')]
  const url = await h.proxy({ headerWaitMs: 20 })
  const received = deferred()
  const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
    response.on('error', () => {})
    response.resume()
    received.resolve(response)
  })
  req.on('error', () => {}) // Intentional client-side destroy must not be unhandled.
  t.after(() => req.destroy())
  req.end(JSON.stringify(chat(messages, { stream: true })))
  const response = await bounded(received.promise, 'HTTP streaming response')
  assert.equal(response.statusCode, 200)
  assert.equal(h.fake.state.userMessages.length, 2)
  req.destroy()
  response.destroy()
  await until(() => h.fake.state.stopGenerations.length === 1, 'HTTP disconnect stop', 700)
  await until(() => h.sessions.size === 0, 'HTTP disconnected prefix invalidation')
  assert.equal(h.fake.state.stopGenerations[0].thread_id, initial.threadId)
  assert.equal(h.audit.restores.length, 0)
  release.resolve()
  await bounded(lateFlushed.promise, 'late HTTP-disconnect events')
  const retried = await bounded(h.call(messages), 'retry after HTTP disconnect')
  assert.equal(retried.status, 200)
  await retried.json()
  const fresh = h.fake.state.userMessages.at(-1).threadId
  assert.notEqual(fresh, initial.threadId)
  assert.deepEqual(h.audit.commits.map((entry) => entry.threadId), [initial.threadId, fresh])
  assert.equal(h.audit.restores.length, 0)
})
