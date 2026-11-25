// The frame is 61,440 bytes and the client's rules, instructions, message,
// tool spec and history all compete for it. These tests pin the ORDER of
// concessions (a global priority, not per-site judgement calls):
//
//   1. the caller's system prompt         never clipped
//   2. this turn's injected instructions  never squeezed
//   3. the current message                capped only when it cannot fit
//   4. the tool spec                      degrades first: full -> lite -> names
//   5. history                            dropped -> uploaded as an attachment
//   6. anything else                      cut, with the reason stated
//
// A change that violates the order fails here instead of in a live session
// where the model reports "my rules were truncated".
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeQuick } from './helpers/fake-quick.ts'
import { handleChatCompletions, cutNote } from '../src/handler.ts'

let fake
before(async () => { fake = await startFakeQuick({}) })
after(async () => { await fake?.close() })

const B = (s) => new TextEncoder().encode(String(s ?? '')).length
const FRAME = 60 * 1024

const RULES_HEAD = 'Codebase and user instructions are shown below. IMPORTANT: These instructions OVERRIDE any default behavior.'
const reminder = (marker, bytes) => `<system-reminder>${RULES_HEAD} ${marker}-HEAD ` + 'r'.repeat(bytes) + ` ${marker}-TAIL</system-reminder>`

/** Verbose tools whose full spec is large, so the ladder has to choose. */
function tools(n, descBytes = 1500) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: {
      name: `Tool${i}`,
      description: `Tool ${i} does things. ` + 'd'.repeat(descBytes),
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'p'.repeat(400) } }, required: ['path'] },
    },
  }))
}

const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

/** Cloud-attachment upload stub: the fake Quick server speaks WS only. */
async function attachFetch(url) {
  const u = String(url)
  if (u.includes('upload-attachment')) return j({ attachmentId: 'att-inv' })
  if (u.includes('attachment-dlp-status')) return j({ dlpJobStatus: 'COMPLETED', policyAction: 'ALLOW' })
  if (u.includes('qbs-event')) return j({ eventResponse: { invokeAgentResponse: { api_response: { status: 200, body: { path: '/data/s3files/u/sessions/t/workspace/attached_files/context.txt' } } } } })
  return j({ error: `unexpected ${u}` }, 404)
}

async function run(body) {
  fake.state.userMessages.length = 0
  const outpost = {
    outpostId: async () => 'inv-1',
    session: async () => ({ ws_host: fake.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
  }
  const res = await handleChatCompletions({
    // Streaming on: notes (what was conceded, that a transcript rode an
    // attachment) only ride the stream — the non-stream shape has no place
    // for them.
    body: { stream: true, ...body },
    outpostMgr: { ensure: async () => outpost },
    options: { identity: 'invariants', log: () => {}, fetchImpl: attachFetch },
  })
  assert.equal(res.status, 200, 'the turn answers')
  const payload = fake.state.userMessages.at(-1).payload
  const frameBytes = B(JSON.stringify({ type: 'user_message', payload }))
  const events = await res.text()
  const said = [...events.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('')
  return { payload, frameBytes, said }
}

const system = (bytes) => 'Rule with a "quote" and a tab\there.\n'.repeat(Math.ceil(bytes / 40))

test('invariant: the frame never exceeds Quick\'s limit', async () => {
  const cases = [
    { system: 0, tools: 0, reminder: 0 },
    { system: 8000, tools: 6, reminder: 4000 },
    { system: 13000, tools: 14, reminder: 16000 },
    { system: 20000, tools: 14, reminder: 19000 },
  ]
  for (const c of cases) {
    const messages = [{ role: 'user', content: reminder('RULES', c.reminder) + '\n\nDo it.' }]
    if (c.system) messages.unshift({ role: 'system', content: system(c.system) })
    const { frameBytes } = await run({ model: 'fast', messages, tools: tools(c.tools) })
    assert.ok(frameBytes <= FRAME + 64, `frame ${frameBytes} over ${FRAME} (case ${JSON.stringify({ ...c, reminder: c.reminder })})`)
  }
})

test('invariant: the caller\'s system prompt is never clipped when it is within reserve', async () => {
  for (const sysBytes of [2000, 8000, 13000, 20000]) {
    const sys = system(sysBytes)
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: reminder('RULES', 16000) + '\n\nDo it.' },
    ]
    const { payload } = await run({ model: 'fast', messages, tools: tools(14) })
    assert.ok(payload.custom_prompt.endsWith(sys), `system prompt clipped at ${sysBytes} bytes`)
  }
})

test('invariant: injected instructions are never squeezed, only the spec degrades', async () => {
  // A 20 KB system prompt + 14 verbose tools + the 16 KB instructions block:
  // something has to give, and the ladder says it is the spec.
  const messages = [
    { role: 'system', content: system(20000) },
    { role: 'user', content: reminder('RULES', 16000) + '\n\nDo it.' },
  ]
  const { payload, said } = await run({ model: 'fast', messages, tools: tools(14) })
  assert.ok(payload.text.includes('RULES-HEAD') && payload.text.includes('RULES-TAIL'))
  assert.ok(!/middle omitted[\s\S]{0,40}RULES/.test(payload.text), 'no squeeze marker inside the rules block')
  // Graduated compression: descriptions give way first, parameter schemas stay.
  assert.ok(payload.text.includes('"required"') || payload.text.includes('"path"'), 'schemas survive the description trim')
  // Description-only caps are silent by policy (schema intact, hits every
  // fresh session's first frame); dropping schemas is what must be stated.
  assert.ok(!said.includes('工具说明过长') && !said.includes('单帧上限'), `a description-only cap is silent: ${said}`)
})

test('invariant: dropping parameter schemas is named', async () => {
  // Schemas big enough that even the 40 KB preamble cap cannot hold the full
  // spec: the builder falls back to names+descriptions, and that loss (schemas
  // gone) has to reach the client.
  const huge = Array.from({ length: 14 }, (_, i) => ({
    type: 'function',
    function: {
      name: `Huge${i}`,
      description: `Does the ${i}th thing. ` + 'd'.repeat(1500),
      parameters: { type: 'object', properties: { path: { type: 'string', enum: Array.from({ length: 8 }, () => 'e'.repeat(250)) } }, required: ['path'] },
    },
  }))
  const messages = [
    { role: 'system', content: system(20000) },
    { role: 'user', content: reminder('RULES', 16000) + '\n\nDo it.' },
  ]
  const { payload, said } = await run({ model: 'fast', messages, tools: huge })
  assert.ok(payload.text.includes('RULES-HEAD') && payload.text.includes('RULES-TAIL'))
  assert.match(said, /已省略参数结构/, 'the schema drop is stated')
  assert.ok(!payload.text.includes('"required"'), 'schemas are gone in this frame')
})

test('invariant: history that cannot fit arrives as an attachment, not as drops', async () => {
  // A long reused-then-lost conversation: the transcript is many times a frame.
  const messages = []
  for (let i = 0; i < 12; i++) {
    messages.push({ role: 'user', content: `Q${i}-` + 'q'.repeat(4000) })
    messages.push({ role: 'assistant', content: `A${i}-` + 'a'.repeat(4000) })
  }
  messages.push({ role: 'user', content: 'FINAL-ASK' })
  const { payload, said } = await run({ model: 'fast', messages, tools: [] })
  assert.match(payload.text, /is in the attached file context_[0-9a-f]{8}\.txt/, 'the transcript rides an attachment')
  assert.ok(payload.attachments.some((a) => a.type === 'file'), 'a file attachment is declared')
  assert.ok(payload.text.includes('FINAL-ASK'))
  assert.match(said, /附件/, 'the client is told')
})

test('invariant: every cut the client can see is named by cutNote', () => {
  assert.match(cutNote({ cut: { tool: 1 } }, false), /工具结果过大/)
  assert.match(cutNote({ cut: { preamble: 1 } }, false), /工具说明过长/)
  // description-only caps keep the schema and hit every fresh session, so they
  // are deliberately silent; schema-dropping tiers must still be named.
  for (const tier of ['desc1200', 'desc600', 'desc300', 'desc120']) {
    assert.equal(cutNote({ cut: { preamble: 1 }, specTier: tier }, false), '', `${tier} is silent`)
  }
  assert.match(cutNote({ cut: { preamble: 1 }, specTier: 'lite' }, false), /省略参数结构/)
  assert.match(cutNote({ cut: { preamble: 1 }, specTier: 'names' }, false), /只保留工具名/)
  assert.match(cutNote({ cut: { turn: 1 } }, false), /当前消息过长/)
  assert.match(cutNote({ cut: { history: 2 } }, false), /2 条较早消息/)
  assert.match(cutNote({ cut: { system: 1 } }, false), /系统指令过长/)
  assert.match(cutNote({ cut: { frame: 1 } }, false), /整帧装不下/)
  // a squeezed reminder alone is duplicated context: no note
  assert.equal(cutNote({ cut: { reminder: 1 } }, false), '')
})

test('invariant: a subagent brief that fits the frame is never cut', async () => {
  // Subagent first turns carry the whole task in one message (~21 KB here,
  // with the instructions block inside it). The old 60%-of-budget pre-cap cut
  // it while 40% of the frame sat unused, leaving a "middle truncated" marker
  // inside the task description.
  const brief = 'TASK-BRIEF ' + 'b'.repeat(21000) + ' FINAL-INSTRUCTION'
  const messages = [{ role: 'system', content: system(10000) }, { role: 'user', content: brief }]
  const { payload, said } = await run({ model: 'fast', messages, tools: tools(9) })
  assert.ok(!said.includes('当前消息过长'), `no turn cut: ${said}`)
  assert.ok(payload.text.includes('FINAL-INSTRUCTION'), 'the brief arrives whole')
  assert.ok(!payload.text.includes('middle truncated'), 'no cut marker inside the brief')
})
