import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _internal } from '../src/index.ts'
import { createSessionStore } from '../src/sessions.ts'
import { startFakeQuick, defaultScript } from './helpers/fake-quick.ts'

const url = 'https://quick.aws.com/magpie-aws-quick/v1/chat/completions'
const user = (content) => ({ role: 'user', content })
const assistant = (content) => ({ role: 'assistant', content })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function backend(fake, over = {}) {
  const outpost = {
    direct: true,
    outpostId: async () => 'plugin-test-device',
    session: async () => ({ ws_host: fake.wsHost, id_token: 'fake', actor_arn: 'plugin-test', usable_until: Date.now() / 1000 + 600 }),
    ...over,
  }
  return { ensure: async () => outpost }
}
const headers = (extra = {}) => ({ 'content-type': 'application/json', 'x-magpie-session': 'main-session', ...extra })
const post = (fetch, messages, extra = {}, body = {}) => fetch(new Request(url, {
  method: 'POST', headers: headers(extra), body: JSON.stringify({ model: 'fast', messages, ...body }),
}))
async function reply(response) {
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()).choices[0].message.content
}

const backgrounds = [
  { name: 'suggestion', prompt: '[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.] Follow the user’s style.' },
  { name: 'away summary', prompt: 'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Focus on the last task.' },
  { name: 'title', prompt: '<session>Continue fixing the bridge.</session>\nWrite the title in English.', system: 'You are naming a coding session so the user can pick it out of a long list of sessions.\n\nReturn JSON with a single "title" field.' },
]
for (const background of backgrounds) {
  for (const fail of [false, true]) {
    test(`plugin Request: ${background.name} ${fail ? 'failure' : 'success'} leaves the main prefix reusable`, async () => {
      let count = 0
      const fake = await startFakeQuick({ script: (p) => ++count === 2 && fail
        ? [{ type: 'error', payload: { message: 'background failed' } }]
        : defaultScript(p) })
      try {
        const sessions = createSessionStore()
        const fetch = _internal.makeFetch(backend(fake), { maxTurnAttempts: 1 }, sessions)
        const a = user('main A')
        const answer = await reply(await post(fetch, [a]))
        assert.equal(sessions.size, 1)
        const history = [a, assistant(answer)]
        const sidebar = [...(background.system ? [{ role: 'system', content: background.system }] : []), ...history, user(background.prompt)]
        const result = await post(fetch, sidebar)
        assert.equal(result.status, fail ? 502 : 200)
        await result.text()
        assert.equal(sessions.size, 1, 'background does not take or commit shared cache')
        await reply(await post(fetch, [...history, user('main B')]))
        const [main, side, continuation] = fake.state.userMessages
        assert.notEqual(side.threadId, main.threadId)
        assert.equal(continuation.threadId, main.threadId)
        assert.equal(continuation.payload.text, 'main B')
      } finally { await fake.close() }
    })
  }
}

test('plugin reads explicit adapter header and init headers override Request headers', async () => {
  const fake = await startFakeQuick({})
  try {
    const sessions = createSessionStore()
    const fetch = _internal.makeFetch(backend(fake), {}, sessions)
    const a = user('A')
    const answer = await reply(await post(fetch, [a]))
    const request = new Request(url, { method: 'POST', headers: headers(), body: JSON.stringify({ messages: [a, assistant(answer), user('opaque background job')] }) })
    await reply(await fetch(request, { headers: headers({ 'X-Magpie-Query-Source': 'away_summary', 'X-Magpie-Effort': 'low' }) }))
    assert.equal(sessions.size, 1)
    assert.equal(fake.state.userMessages.at(-1).payload.thinking_effort, 'low')
    await reply(await post(fetch, [a, assistant(answer), user('B')]))
    assert.equal(fake.state.userMessages.at(-1).threadId, fake.state.userMessages[0].threadId)
  } finally { await fake.close() }
})

test('plugin partitions a normal subagent while retaining independent multi-turn reuse', async () => {
  const fake = await startFakeQuick({})
  try {
    const fetch = _internal.makeFetch(backend(fake), {}, createSessionStore())
    const a = user('same opening')
    const mainAnswer = await reply(await post(fetch, [a]))
    const subAnswer = await reply(await post(fetch, [a], { 'x-magpie-subagent': 'worker-1' }))
    await reply(await post(fetch, [a, assistant(subAnswer), user('worker B')], { 'x-magpie-subagent': 'worker-1' }))
    await reply(await post(fetch, [a, assistant(mainAnswer), user('main B')]))
    const [main, sub, sub2, main2] = fake.state.userMessages
    assert.notEqual(sub.threadId, main.threadId)
    assert.equal(sub2.threadId, sub.threadId)
    assert.equal(main2.threadId, main.threadId)
    assert.equal(sub2.payload.text, 'worker B')
    assert.equal(main2.payload.text, 'main B')
  } finally { await fake.close() }
})

test('plugin Request.signal cancels a pending preparation without init.signal', async () => {
  let resolve
  let identities = 0
  const ensure = new Promise((r) => { resolve = r })
  const fetch = _internal.makeFetch({ ensure: () => ensure }, { requestTimeoutMs: 1000 }, createSessionStore())
  const controller = new AbortController()
  const pending = fetch(new Request(url, { method: 'POST', body: JSON.stringify({ messages: [user('A')] }), signal: controller.signal }))
  controller.abort()
  const response = await pending
  assert.equal(response.status, 499)
  resolve({ session: async () => { identities++; return {} } })
  await sleep(10)
  assert.equal(identities, 0, 'cancelled preparation must not advance into identity or handler')
})

test('plugin deadline covers reading the Request body and prevents backend preparation', async () => {
  let ensures = 0
  const fetch = _internal.makeFetch({ ensure: async () => { ensures++; return {} } }, { requestTimeoutMs: 40 }, createSessionStore())
  let cancelled = 0
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
    cancel() { cancelled++ },
  })
  const request = new Request(url, { method: 'POST', body, duplex: 'half' })
  const response = await fetch(request)
  assert.equal(response.status, 503)
  assert.match((await response.json()).error.message, /requestTimeoutMs=40ms/)
  await sleep(0)
  assert.equal(cancelled, 1, 'deadline cancels the actual body source, not just the wait')
  assert.equal(request.body.locked, false)
  assert.equal(ensures, 0)
})

test('plugin streaming Request body preserves UTF-8 split across chunks', async () => {
  const fake = await startFakeQuick({})
  try {
    const fetch = _internal.makeFetch(backend(fake), {}, createSessionStore())
    const bytes = new TextEncoder().encode(JSON.stringify({ messages: [user('颜色：青色')] }))
    const body = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    const request = new Request(url, { method: 'POST', body, duplex: 'half' })
    await reply(await fetch(request))
    assert.equal(fake.state.userMessages[0].payload.text, '颜色：青色')
    assert.equal(request.body.locked, false)
  } finally { await fake.close() }
})

test('plugin cancellation during body reading cancels the actual source', async () => {
  let cancelled = 0
  const controller = new AbortController()
  const body = new ReadableStream({ cancel() { cancelled++ } })
  const request = new Request(url, { method: 'POST', body, duplex: 'half', signal: controller.signal })
  const fetch = _internal.makeFetch({ ensure() { assert.fail('body cancellation must not prepare a backend') } }, { requestTimeoutMs: 0 }, createSessionStore())
  const pending = fetch(request)
  await sleep(0)
  controller.abort()
  const response = await pending
  assert.equal(response.status, 499)
  await sleep(0)
  assert.equal(cancelled, 1)
  assert.equal(request.body.locked, false)
})

test('plugin deadline covers shared ensure and identity waits without late advancement', async () => {
  for (const stage of ['ensure', 'identity']) {
    let resolve
    let identities = 0
    const wait = new Promise((r) => { resolve = r })
    const outpost = { session: async () => { identities++; return stage === 'identity' ? wait : {} } }
    const fetch = _internal.makeFetch({ ensure: () => stage === 'ensure' ? wait : Promise.resolve(outpost) }, { requestTimeoutMs: 40 }, createSessionStore())
    const response = await post(fetch, [user('A')])
    assert.equal(response.status, 503, stage)
    resolve(stage === 'ensure' ? outpost : {})
    await sleep(10)
    assert.equal(identities, stage === 'identity' ? 1 : 0)
  }
})
