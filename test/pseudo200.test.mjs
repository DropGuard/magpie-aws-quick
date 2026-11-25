import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeQuick, defaultScript } from './helpers/fake-quick.ts'
import { handleChatCompletions } from '../src/handler.ts'
import { isPseudo200UsageLimitText, isPseudo200UsageLimitPrefix, resetQuotaWindows, quotaCooldownLeft } from '../src/handler.ts'

const QUOTA_SENTENCE = "You've reached your usage limit. Check your profile for details."

// script mode switched per test
let mode = 'quota-stream'
let fake
let outpostMgr

async function scriptFor(payload) {
  const mid = payload?.message_id || 'm1'
  if (mode === 'quota-stream') {
    // the exact quota sentence, streamed in small pieces like a normal reply
    const parts = [QUOTA_SENTENCE.slice(0, 20), QUOTA_SENTENCE.slice(20, 45), QUOTA_SENTENCE.slice(45)]
    return [
      { type: 'message_start', payload: { message_id: mid } },
      ...parts.map((delta) => ({ type: 'text_delta', payload: { delta, kernel_thread_id: 'home' } })),
      { type: 'text_complete', payload: { text: QUOTA_SENTENCE, message_id: mid } },
      { type: 'message_complete', payload: { text: QUOTA_SENTENCE, message_id: mid, kernel_thread_id: 'home' } },
    ]
  }
  if (mode === 'quota-complete-only') {
    // no deltas: the whole (quota) message arrives in message_complete only
    return [
      { type: 'message_start', payload: { message_id: mid } },
      { type: 'turn_usage', payload: { input_tokens: 3, output_tokens: 9, total_tokens: 12 } },
      { type: 'message_complete', payload: { text: QUOTA_SENTENCE, message_id: mid, kernel_thread_id: 'home' } },
    ]
  }
  if (mode === 'quota-error-frame') {
    return [
      { type: 'message_start', payload: { message_id: mid } },
      { type: 'error', payload: { error_type: 'usage_limit', message: 'usage limit reached' } },
    ]
  }
  if (mode === 'quote-continuation') {
    // a real answer that QUOTES the sentence then keeps explaining — not exhaustion
    const text = `${QUOTA_SENTENCE} — this error means your account is out of minutes, here is what to do next.`
    return [
      { type: 'message_start', payload: { message_id: mid } },
      { type: 'text_delta', payload: { delta: text.slice(0, 60), kernel_thread_id: 'home' } },
      { type: 'text_delta', payload: { delta: text.slice(60), kernel_thread_id: 'home' } },
      { type: 'text_complete', payload: { text, message_id: mid } },
      { type: 'message_complete', payload: { text, message_id: mid, kernel_thread_id: 'home' } },
    ]
  }
  return defaultScript(payload)
}

before(async () => {
  fake = await startFakeQuick({ script: (p) => scriptFor(p) })
  const outpost = {
    outpostId: async () => 'outpost-test-1',
    session: async () => ({
      ws_host: fake.wsHost,
      id_token: 'test-token',
      actor_arn: 'arn:test',
      provider: 'social',
      aws_account_id: '123456789012',
      usable_until: Math.floor(Date.now() / 1000) + 600,
    }),
  }
  outpostMgr = { ensure: async () => outpost }
})

after(async () => { await fake?.close() })

function req(body) {
  return handleChatCompletions({
    body,
    outpostMgr,
    options: { identity: 'test-acct', log: () => {} },
  })
}

test('unit: exact-match and prefix classifiers', () => {
  assert.ok(isPseudo200UsageLimitText(QUOTA_SENTENCE))
  assert.ok(isPseudo200UsageLimitText(QUOTA_SENTENCE + '\n'))
  assert.ok(isPseudo200UsageLimitText('  ' + QUOTA_SENTENCE))
  assert.ok(isPseudo200UsageLimitText("You have reached your usage limit. Check your profile for details"))
  assert.ok(!isPseudo200UsageLimitText(QUOTA_SENTENCE + ' extra'))
  assert.ok(!isPseudo200UsageLimitText('hello'))
  assert.ok(isPseudo200UsageLimitPrefix("You've reached your usage"))
  assert.ok(isPseudo200UsageLimitPrefix(''))
  assert.ok(!isPseudo200UsageLimitPrefix('The answer is'))
})

test('streamed pseudo-200 quota reply becomes a 429 rate_limit_error, never reaching the client', async () => {
  mode = 'quota-stream'
  const res = await req({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 429)
  const json = await res.json()
  assert.equal(json.error.type, 'rate_limit_error')
  assert.match(json.error.message, /用量已用尽|usage limit/i)
  assert.ok(!JSON.stringify(json).includes('Check your profile'))
})

test('streamed pseudo-200 in streaming mode also errors before headers', async () => {
  mode = 'quota-stream'
  const res = await req({ model: 'fast', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 429)
})

test('quota sentence arriving only in message_complete is caught', async () => {
  mode = 'quota-complete-only'
  const res = await req({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 429)
  const json = await res.json()
  assert.equal(json.error.type, 'rate_limit_error')
})

test('usage_limit error frame maps to 429', async () => {
  mode = 'quota-error-frame'
  const res = await req({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 429)
  const json = await res.json()
  assert.equal(json.error.type, 'rate_limit_error')
})

test('a reply that quotes the quota sentence then continues passes through untouched', async () => {
  resetQuotaWindows()
  mode = 'quote-continuation'
  const res = await req({ model: 'fast', messages: [{ role: 'user', content: 'explain the error' }] })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.match(json.choices[0].message.content, /usage limit/)
  assert.match(json.choices[0].message.content, /what to do next/)
})

test('normal replies are unaffected by the probe', async () => {
  resetQuotaWindows()
  mode = 'default'
  const res = await req({ model: 'fast', messages: [{ role: 'user', content: 'capital of France?' }] })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.ok(json.choices[0].message.content.startsWith('echo:'))
})

test('after a quota failure the account fails fast (429) without touching upstream', async () => {
  resetQuotaWindows()
  mode = 'quota-stream'
  const before = fake.state.userMessages.length
  const r1 = await req({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(r1.status, 429)
  assert.ok(quotaCooldownLeft('test-acct') > 0, 'exhaustion window recorded')
  // next request never reaches upstream — zero new user_messages
  const r2 = await req({ model: 'fast', messages: [{ role: 'user', content: 'again' }] })
  assert.equal(r2.status, 429)
  assert.match((await r2.json()).error.message, /resumes in/i)
  assert.equal(fake.state.userMessages.length, before + 1, 'no extra upstream turn burned')
  resetQuotaWindows()
  mode = 'default'
})

test('exhaustionMinutes prefers session resume_in_minutes, then monthly reset', async () => {
  const { exhaustionMinutes } = await import('../src/handler.ts')
  assert.equal(exhaustionMinutes({ session: { exhausted: true, resumeInMinutes: 42 }, monthly: { exhausted: false } }), 42)
  assert.equal(exhaustionMinutes({ session: { exhausted: true, resumeInMinutes: 0 } }), 30)
  const monthlyOnly = exhaustionMinutes({ session: { exhausted: false }, monthly: { exhausted: true, resetsAt: new Date(Date.now() + 3600_000).toISOString() } })
  assert.ok(monthlyOnly > 55 && monthlyOnly <= 60)
  assert.equal(exhaustionMinutes({ session: { exhausted: false }, monthly: { exhausted: false } }), 0)
  assert.equal(exhaustionMinutes(null), 0)
})
