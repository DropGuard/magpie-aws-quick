import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createProxyServer } from '../bin/serve.mjs'
import { createSessionStore } from '../src/sessions.ts'
import { classifyRequest } from '../src/request-context.ts'
import { startFakeQuick } from './helpers/fake-quick.ts'

const user = (content) => ({ role: 'user', content })
const assistant = (content) => ({ role: 'assistant', content })

async function fixture(t, { options = {}, token = '', script } = {}) {
  const fake = await startFakeQuick({ script, staleStop: false })
  const outpost = {
    outpostId: async () => 'proxy-fake-outpost',
    session: async () => ({
      ws_host: fake.wsHost, id_token: 'local-fake-token', actor_arn: 'arn:test',
      provider: 'social', aws_account_id: '123456789012', usable_until: Math.floor(Date.now() / 1000) + 600,
    }),
  }
  const state = { ensureCalls: 0, matches: [], commits: [], responses: [] }
  const outpostMgr = { ensure: async () => { state.ensureCalls++; return outpost } }
  const store = createSessionStore()
  const sessions = {
    match(args) { state.matches.push(args); return store.match(args) },
    commit(entry) { state.commits.push(entry); store.commit(entry) },
    restore(entry) { store.restore(entry) },
  }
  const server = createProxyServer({
    options: { identity: 'proxy-test-account', log: () => {}, ...options }, token, outpostMgr, sessions,
  })
  server.prependListener('request', (req, res) => {
    const response = { req, res, finishes: 0, closes: 0 }
    state.responses.push(response)
    res.on('finish', () => response.finishes++)
    res.on('close', () => response.closes++)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fake.close()
  })
  return { fake, outpost, outpostMgr, store, state, base: `http://127.0.0.1:${server.address().port}` }
}

async function post(f, messages, headers = {}, extra = {}) {
  return fetch(`${f.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'fast', messages, ...extra }), signal: AbortSignal.timeout(5_000),
  })
}

async function complete(f, messages, headers, extra) {
  const response = await post(f, messages, headers, extra)
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return body.choices[0].message.content
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('local condition did not settle')
    await delay(10)
  }
}

function rawPost(f, { headers = {} } = {}) {
  let req
  const result = new Promise((resolve, reject) => {
    req = request(`${f.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, aborted: false }))
      res.on('aborted', () => reject(new Error('response aborted')))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
  return { req, result }
}

test('proxy: preserves Bearer and x-api-key authentication for health, models and chat', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t, { token: 'local-proxy-secret' })
  for (const path of ['/health', '/v1/models']) {
    const denied = await fetch(`${f.base}${path}`)
    assert.equal(denied.status, 401)
    assert.equal((await denied.json()).error.type, 'authentication_error')
  }
  const denied = await post(f, [user('hello')])
  assert.equal(denied.status, 401)
  await denied.text()
  assert.equal(f.state.ensureCalls, 0)
  const health = await fetch(`${f.base}/health`, { headers: { authorization: 'Bearer local-proxy-secret' } })
  assert.deepEqual(await health.json(), { ok: true })
  const models = await fetch(`${f.base}/v1/models`, { headers: { 'x-api-key': 'local-proxy-secret' } })
  assert.equal(models.status, 200)
  assert.equal((await models.json()).data.length, 4)
  const conflict = await post(f, [user('hello')], { authorization: 'Bearer wrong', 'x-api-key': 'local-proxy-secret' })
  assert.equal(conflict.status, 401, 'a wrong nonempty Authorization header must not fall through to x-api-key')
  await conflict.text()
  await complete(f, [user('hello')], { 'x-api-key': 'local-proxy-secret' })
  await complete(f, [user('hello again')], { authorization: 'bEaReR local-proxy-secret' })
  assert.equal(f.fake.state.userMessages.length, 2)
})

test('proxy: real affinity headers keep precedence and effort reaches the fake transport', { timeout: 8_000 }, async (t) => {
  const f = await fixture(t, { options: { sessionKey: 'configured-fallback' } })
  const names = ['x-magpie-session', 'session_id', 'x-session-id', 'x-session-affinity', 'x-client-request-id', 'x-thread-id', 'x-conversation-id']
  for (let start = 0; start < names.length; start++) {
    const headers = Object.fromEntries(names.map((name, index) => [name, index < start ? '' : `affinity-${index}`]))
    await complete(f, [user(`header-${start}`)], { ...headers, 'X-Magpie-Effort': 'low' }, { reasoning_effort: 'high' })
    assert.equal(f.state.matches.at(-1).session, `affinity-${start}`)
    assert.equal(f.state.commits.at(-1).session, `affinity-${start}`)
    assert.equal(f.fake.state.userMessages.at(-1).payload.thinking_effort, 'low')
  }
  await complete(f, [user('no affinity header')])
  assert.equal(f.state.matches.at(-1).session, 'configured-fallback')
})

test('proxy: real background query-source headers never consume or overwrite the parent cache', { timeout: 8_000 }, async (t) => {
  const f = await fixture(t)
  const headers = { 'x-magpie-session': 'proxy-parent' }
  const first = user('Implement cache affinity')
  const answer = await complete(f, [first], headers)
  const parentThread = f.fake.state.userMessages.at(-1).threadId
  const matches = f.state.matches.length
  const commits = f.state.commits.length
  const backgroundThreads = new Set()
  for (const kind of ['prompt_suggestion', 'away_summary', 'generate_session_title']) {
    await complete(f, [first, assistant(answer), user(`Ordinary follow-up with explicit ${kind} purpose`)], {
      ...headers, 'x-magpie-query-source': kind,
    }, { tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }] })
    const backgroundThread = f.fake.state.userMessages.at(-1).threadId
    assert.notEqual(backgroundThread, parentThread)
    backgroundThreads.add(backgroundThread)
    assert.equal(f.state.matches.length, matches)
    assert.equal(f.state.commits.length, commits)
    assert.equal(f.store.size, 1)
  }
  assert.equal(backgroundThreads.size, 3)
  await complete(f, [first, assistant(answer), user('Continue the main task')], headers)
  assert.equal(f.fake.state.userMessages.at(-1).threadId, parentThread)
  assert.equal(f.store.size, 1)
})

test('proxy: main-to-subagent transitions split affinity and each lane continues its own cache', { timeout: 8_000 }, async (t) => {
  const f = await fixture(t)
  const sessionKey = `parent-${'x'.repeat(180)}`
  const mainHeaders = { 'x-magpie-session': sessionKey }
  const aHeaders = { ...mainHeaders, 'x-magpie-subagent': 'child-A' }
  const bHeaders = { ...mainHeaders, 'x-magpie-subagent': 'child-B' }
  const first = user('Find the cache issue')
  const mainAnswer = await complete(f, [first], mainHeaders)
  const mainThread = f.fake.state.userMessages.at(-1).threadId
  const childStart = [first, assistant(mainAnswer), user('Inspect the cache branch')]
  const childAnswer = await complete(f, childStart, aHeaders)
  const childThread = f.fake.state.userMessages.at(-1).threadId
  const partition = f.state.commits.at(-1).session
  assert.notEqual(childThread, mainThread)
  assert.equal(partition, classifyRequest({}, { sessionKey, subagentKey: 'child-A' }).sessionKey)
  assert.ok(partition.length < 128)
  const nextChild = [...childStart, assistant(childAnswer), user('Continue inspecting')]
  const nextAnswer = await complete(f, nextChild, aHeaders)
  assert.equal(f.fake.state.userMessages.at(-1).threadId, childThread)
  await complete(f, childStart, bHeaders)
  assert.notEqual(f.fake.state.userMessages.at(-1).threadId, childThread)
  assert.notEqual(f.fake.state.userMessages.at(-1).threadId, mainThread)
  await complete(f, [first, assistant(mainAnswer), user('Continue the main investigation')], mainHeaders)
  assert.equal(f.fake.state.userMessages.at(-1).threadId, mainThread)
  await complete(f, [...nextChild, assistant(nextAnswer), user('Finish the branch inspection')], aHeaders)
  assert.equal(f.fake.state.userMessages.at(-1).threadId, childThread)
  assert.equal(f.store.size, 3)
})

test('proxy: JSON and route errors finish once without starting the fake backend', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t)
  const invalid = await fetch(`${f.base}/v1/chat/completions`, { method: 'POST', body: '{broken' })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.type, 'invalid_request_error')
  const unknown = await fetch(`${f.base}/unknown`)
  assert.equal(unknown.status, 404)
  await unknown.text()
  assert.equal(f.state.ensureCalls, 0)
  await waitFor(() => f.state.responses.every((record) => record.finishes === 1))
})

test('proxy: request deadline covers an unfinished body upload', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t, { options: { requestTimeoutMs: 100 } })
  const { req, result } = rawPost(f)
  t.after(() => req.destroy())
  req.write('{"messages":[')
  const response = await result
  assert.equal(response.status, 503)
  assert.match(JSON.parse(response.text).error.message, /requestTimeoutMs=100ms/)
  assert.equal(response.headers.connection, 'close')
  assert.equal(f.state.ensureCalls, 0)
  await waitFor(() => f.state.responses[0].finishes === 1)
})

test('proxy: deadline starts before body reading and is shared with backend preparation', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t, { options: { requestTimeoutMs: 400 } })
  f.outpostMgr.ensure = async () => { f.state.ensureCalls++; return new Promise(() => {}) }
  const { req, result } = rawPost(f)
  t.after(() => req.destroy())
  req.write('{"messages":[')
  await waitFor(() => f.state.responses.length === 1)
  const started = Date.now()
  await delay(220)
  req.end('{"role":"user","content":"hello"}]}')
  const response = await result
  const elapsed = Date.now() - started
  assert.equal(response.status, 503)
  assert.match(JSON.parse(response.text).error.message, /requestTimeoutMs=400ms/)
  assert.equal(f.state.ensureCalls, 1)
  assert.equal(f.fake.state.userMessages.length, 0)
  assert.ok(elapsed < 550, `deadline must not restart after the upload (${elapsed}ms)`)
  await waitFor(() => f.state.responses[0].finishes === 1)
})

test('proxy: requestTimeoutMs=0 allows delayed preparation and normal request-close does not abort', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t, { options: { requestTimeoutMs: 0 } })
  f.outpostMgr.ensure = async () => { f.state.ensureCalls++; await delay(120); return f.outpost }
  await complete(f, [user('normal upload followed by delayed preparation')])
  assert.equal(f.fake.state.userMessages.length, 1)
  assert.equal(f.state.responses[0].req.complete, true)
  assert.equal(f.state.responses[0].finishes, 1)
})

test('proxy: maxTurnAttempts reaches the handler and prevents an empty-answer retry', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t, {
    options: { maxTurnAttempts: 1, answerRetries: 2, requestTimeoutMs: 1_000 },
    script: () => [{ type: 'message_complete', payload: { text: '', tool_calls: [], initiator: 'user' } }],
  })
  const response = await post(f, [user('hello')])
  assert.equal(response.status, 502)
  assert.match((await response.json()).error.message, /reasoning only|empty|没有给出任何回答|答案为空/i)
  assert.equal(f.fake.state.userMessages.length, 1)
  assert.equal(f.store.size, 0)
})

test('proxy: incomplete request-close cancels body reading without sending a second response', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t, { options: { requestTimeoutMs: 0 } })
  const req = request(`${f.base}/v1/chat/completions`, { method: 'POST' })
  req.on('error', () => {})
  req.write('{"messages":[')
  await waitFor(() => f.state.responses.length === 1)
  req.destroy()
  await waitFor(() => f.state.responses[0].closes === 1)
  assert.equal(f.state.responses[0].finishes, 0)
  assert.equal(f.state.ensureCalls, 0)
  const health = await fetch(`${f.base}/health`)
  assert.equal(health.status, 200)
  await health.text()
})

test('proxy: response-close during preparation aborts the scope even with its deadline disabled', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t, { options: { requestTimeoutMs: 0 } })
  let finishEnsure
  f.outpostMgr.ensure = async () => {
    f.state.ensureCalls++
    return new Promise((resolve) => { finishEnsure = resolve })
  }
  const req = request(`${f.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } })
  req.on('error', () => {})
  req.end(JSON.stringify({ messages: [user('cancel before backend preparation finishes')] }))
  await waitFor(() => f.state.ensureCalls === 1)
  req.destroy()
  await waitFor(() => f.state.responses[0].closes === 1)
  finishEnsure(f.outpost)
  await delay(70)
  assert.equal(f.fake.state.userMessages.length, 0)
  assert.equal(f.fake.state.connections, 0)
  assert.equal(f.state.responses[0].finishes, 0)
  assert.equal(f.store.size, 0)
})

test('proxy: a deadline after SSE data never appends a second JSON response', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t, {
    options: { requestTimeoutMs: 250, headerWaitMs: 20, initialIdleTimeoutMs: 2_000, idleTimeoutMs: 2_000 },
    script: () => [{ type: 'text_delta', payload: { delta: 'started local fake response' } }],
  })
  const response = await post(f, [user('stream until deadline')], {}, { stream: true })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const text = await response.text() // Must complete, not terminate the HTTP socket.
  assert.match(text, /started local fake response/)
  assert.ok(text.split('\n').every((line) => line === '' || line.startsWith('data: ')), text)
  const events = text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)))
  const error = events.find((event) => event.error)?.error
  assert.equal(error?.code, 503)
  assert.match(error.message, /requestTimeoutMs=250ms/)
  assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1)
  await waitFor(() => f.fake.state.stopGenerations.length >= 1)
  assert.equal(f.state.responses.length, 1)
  assert.equal(f.state.responses[0].finishes, 1)
  assert.equal(f.store.size, 0)
})

test('proxy: body reader preserves UTF-8 split across upload chunks', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t)
  const { req, result } = rawPost(f)
  t.after(() => req.destroy())
  const body = Buffer.from(JSON.stringify({ messages: [user('你好，检查缓存')] }))
  const split = body.indexOf(Buffer.from('你好')) + 1
  req.write(body.subarray(0, split))
  await delay(10)
  req.end(body.subarray(split))
  assert.equal((await result).status, 200)
  assert.match(f.fake.state.userMessages[0].payload.text, /你好，检查缓存/)
})
