#!/usr/bin/env node
// Differential check: the TypeScript tree against the reference .mjs tree that
// magpie currently serves.
//
// The test suite proves "the same assertions still hold". This proves the
// stronger claim the port needs: for identical input, both implementations
// send the exact same bytes to Quick and return the exact same response. Any
// diff is a behaviour change and must be explained — either as an intentional
// improvement (move the scenario to KNOWN_DIFFS with a reason) or as a bug.
//
// What is compared, per scenario:
//   - every user_message payload (text, custom_prompt, system_prompt, base
//     fields, attachments, …) in send order
//   - thread identity RELATIONS, labelled thread-1/thread-2 in first-use order
//     (reuse vs fresh is behaviour; the random ids are not)
//   - every response body, or every SSE frame for streaming
//
// What is normalised away (nondeterministic, not behaviour):
//   - UUIDs (message_id, thread ids inside text, attachment file names)
//   - call_… tool-call ids, chatcmpl-… response ids
//   - `created` timestamps
//
// Usage: node scripts/differential.mjs [path-to-reference-tree]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startFakeQuick, defaultScript } from '../test/helpers/fake-quick.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.dirname(here)
const refDir = path.resolve(process.argv[2] ?? path.join(repo, '..', 'magpie-aws-quick'))
if (!existsSync(path.join(refDir, 'lib/handler.mjs'))) {
  console.error(`reference tree not found: ${refDir} (pass its path as the first argument)`)
  process.exit(2)
}

const load = async (file) => import(pathToFileURL(file).href)
/** The exact commit a "all identical" result is relative to — print it so a
 *  later run can tell whether the baseline itself moved. */
function refCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}
console.log(`reference: ${refDir} @ ${refCommit(refDir)}\n`)
const TS = {
  name: 'ts',
  handleChatCompletions: (await load(path.join(repo, 'src/handler.ts'))).handleChatCompletions,
  createSessionStore: (await load(path.join(repo, 'src/sessions.ts'))).createSessionStore,
}
const REF = {
  name: 'ref',
  handleChatCompletions: (await load(path.join(refDir, 'lib/handler.mjs'))).handleChatCompletions,
  createSessionStore: (await load(path.join(refDir, 'lib/sessions.mjs'))).createSessionStore,
}

// ------------------------------------------------------------- fixtures ----
const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

const fnTool = (name) => ({
  type: 'function',
  function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } } },
})
/** Large enough that the tool spec has to degrade (preamble note). */
const bigTools = Array.from({ length: 14 }, (_, i) => ({
  type: 'function',
  function: {
    name: `Tool${i}`,
    description: `Does the ${i}th thing. ` + 'd'.repeat(1500),
    // Big schemas: force the ladder to 'lite' (a named loss) so this scenario
    // compares both trees on a tier that still reports itself.
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'p'.repeat(1800) } }, required: ['path'] },
  },
}))
/** A conversation far past one 64 KB frame. */
const oversizedConvo = (finalAsk = 'FINAL-ASK: what should I do next?') => {
  const messages = []
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `QUESTION-${i}-` + 'q'.repeat(4000) })
    messages.push({ role: 'assistant', content: `ANSWER-${i}-` + 'a'.repeat(4000) })
  }
  messages.push({ role: 'user', content: finalAsk })
  return messages
}
const attachFetch = () => async (url) => {
  const u = String(url)
  if (u.includes('upload-attachment')) return j({ attachmentId: 'att-ctx' })
  if (u.includes('attachment-dlp-status')) return j({ dlpJobStatus: 'COMPLETED', policyAction: 'ALLOW' })
  if (u.includes('qbs-event')) return j({ eventResponse: { invokeAgentResponse: { api_response: { status: 200, body: { path: '/v1/context.txt' } } } } })
  return j({ error: `unexpected ${u}` }, 404)
}
const mgr = (f) => ({
  ensure: async () => ({
    outpostId: async () => 'o-diff',
    session: async () => ({ ws_host: f.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
  }),
})

/** One fake Quick + one session store shared by a scenario's turns. */
async function withFake(impl, identity, { script, fetchImpl } = {}, fn) {
  const f = await startFakeQuick(script ? { script } : {})
  const sessions = impl.createSessionStore()
  try {
    const call = async (body, options = {}) => {
      const res = await impl.handleChatCompletions({
        body,
        outpostMgr: mgr(f),
        sessions,
        options: { identity, log: () => {}, ...(fetchImpl ? { fetchImpl } : {}), ...options },
      })
      return { status: res.status, response: await readBody(res) }
    }
    return await fn({ call, wire: () => f.state.userMessages })
  } finally {
    await f.close()
  }
}

async function readBody(res) {
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/event-stream')) return { stream: parseSse(await res.text()) }
  try { return { json: await res.json() } } catch { return { text: await res.text() } }
}

function parseSse(text) {
  const out = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const data = line.slice(6)
    if (data === '[DONE]') { out.push('[DONE]'); continue }
    try { out.push(JSON.parse(data)) } catch { out.push(data) }
  }
  return out
}

// ---------------------------------------------------------- normalisation ----
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = k === 'created' ? 0 : normalize(x)
    return out
  }
  if (typeof v === 'string') {
    return v
      .replace(UUID_RE, '<uuid>')
      .replace(/call_[0-9a-f]{24}/g, '<call>')
      .replace(/chatcmpl-quick-[0-9a-f]{8}-[0-9a-z]+/g, '<completion>')
      .replace(/context_[0-9a-f]{8}\.txt/g, 'context_<rand>.txt')
  }
  return v
}

/** Label threads by first use so reuse relations compare without the random ids. */
function normalizeRun({ wire, responses }) {
  const labels = new Map()
  return {
    wire: wire.map(({ threadId, payload }) => {
      if (!labels.has(threadId)) labels.set(threadId, `thread-${labels.size + 1}`)
      return { thread: labels.get(threadId), payload: normalize(payload) }
    }),
    responses: normalize(responses),
  }
}

// --------------------------------------------------------------- scenarios ----
const GUARDRAIL_EVENT = { type: 'guardrail_blocked', payload: { message: 'That content did not pass our automated check.' } }
const PSEUDO200 = "You've reached your usage limit. Check your profile for details."

// Intentional divergences from the reference tree, each with the reason it is
// an improvement rather than drift. Everything else must match byte for byte.
const KNOWN_DIFFS = {
  'guardrail stop is retried on the same thread':
    'TS keeps the turn text and appends the nudge; the reference replaced the whole message with it (the model lost the request)',
  'guardrail budget spent surfaces the labelled error':
    'same fix: the retried frame now carries the original text plus the nudge',
}

const SCENARIOS = {
  'fresh thread with tools (non-stream)': async (impl, identity) => withFake(impl, identity, {}, async ({ call, wire }) => {
    const responses = [await call({ model: 'smart', messages: [{ role: 'user', content: 'make a file' }], tools: [fnTool('Write')] })]
    return { wire: wire(), responses }
  }),

  'reused thread + tool result (non-stream)': async (impl, identity) => {
    let n = 0
    return withFake(impl, identity, {
      script: (p) => {
        n++
        if (n === 1) {
          return [
            { type: 'text_delta', payload: { delta: 'Writing it. <tool_call>{"name":"Write","arguments":{"file_path":"a.txt","content":"hi"}}</tool_call>' } },
            { type: 'turn_usage', payload: { input_tokens: 5, output_tokens: 6, total_tokens: 11 } },
            { type: 'message_complete', payload: { text: '' } },
          ]
        }
        return defaultScript(p)
      },
    }, async ({ call, wire }) => {
      const u1 = { role: 'user', content: 'make a file' }
      const r1 = await call({ model: 'smart', messages: [u1], tools: [fnTool('Write')] })
      const message = r1.response.json.choices[0].message
      const r2 = await call({
        model: 'smart',
        tools: [fnTool('Write')],
        messages: [u1, { role: 'assistant', content: message.content, tool_calls: message.tool_calls }, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'written' }],
      })
      return { wire: wire(), responses: [r1, r2] }
    })
  },

  'oversize transcript becomes an attachment (stream), then reuses': async (impl, identity) => withFake(impl, identity, { fetchImpl: attachFetch() }, async ({ call, wire }) => {
    const r1 = await call({ model: 'smart', stream: true, messages: oversizedConvo() })
    const content = (r1.response.stream || [])
      .map((f) => f?.choices?.[0]?.delta?.content || '')
      .join('')
    const r2 = await call({
      model: 'smart',
      messages: [...oversizedConvo(), { role: 'assistant', content }, { role: 'user', content: 'next step' }],
    })
    return { wire: wire(), responses: [r1, r2] }
  }),

  'inline image stays inline (non-stream)': async (impl, identity) => withFake(impl, identity, {}, async ({ call, wire }) => {
    const img = Buffer.alloc(64, 5).toString('base64')
    const responses = [await call({
      model: 'fast',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } }] }],
    })]
    return { wire: wire(), responses }
  }),

  'guardrail stop is retried on the same thread': async (impl, identity) => {
    let n = 0
    return withFake(impl, identity, { script: (p) => (++n === 1 ? [GUARDRAIL_EVENT] : defaultScript(p)) }, async ({ call, wire }) => {
      const responses = [await call({ model: 'fast', messages: [{ role: 'user', content: 'write a script' }] })]
      return { wire: wire(), responses }
    })
  },

  'dead cached thread retries on a fresh thread': async (impl, identity) => {
    let n = 0
    return withFake(impl, identity, {
      script: (p) => {
        n++
        if (n === 2) return [{ type: 'error', payload: { message: 'thread not found' } }]
        return defaultScript(p)
      },
    }, async ({ call, wire }) => {
      const u1 = { role: 'user', content: 'first task' }
      const r1 = await call({ model: 'fast', messages: [u1], tools: [fnTool('Bash')] })
      const content = r1.response.json.choices[0].message.content
      const r2 = await call({ model: 'fast', tools: [fnTool('Bash')], messages: [u1, { role: 'assistant', content }, { role: 'user', content: 'keep going' }] })
      return { wire: wire(), responses: [r1, r2] }
    })
  },

  'guardrail budget spent surfaces the labelled error': async (impl, identity) => {
    return withFake(impl, identity, { script: () => [GUARDRAIL_EVENT] }, async ({ call, wire }) => {
      const responses = [await call({ model: 'fast', messages: [{ role: 'user', content: 'write a script' }] })]
      return { wire: wire(), responses }
    })
  },

  'guardrail on the fresh retry surfaces as-is (no second retry)': async (impl, identity) => {
    let n = 0
    return withFake(impl, identity, {
      script: (p) => {
        n++
        if (n === 1) return defaultScript(p)
        if (n === 2) return [{ type: 'error', payload: { message: 'thread not found' } }]
        return [GUARDRAIL_EVENT]
      },
    }, async ({ call, wire }) => {
      const u1 = { role: 'user', content: 'first task' }
      const r1 = await call({ model: 'fast', messages: [u1], tools: [fnTool('Bash')] })
      const content = r1.response.json.choices[0].message.content
      const r2 = await call({ model: 'fast', tools: [fnTool('Bash')], messages: [u1, { role: 'assistant', content }, { role: 'user', content: 'keep going' }] })
      return { wire: wire(), responses: [r1, r2] }
    })
  },

  'invalid <tool_call> becomes the placeholder, then is restated': async (impl, identity) => {
    let n = 0
    return withFake(impl, identity, {
      script: (p) => {
        n++
        if (n === 1) {
          return [
            { type: 'text_delta', payload: { delta: 'Done.\nNext. <tool_call>{"name":"Bash","arguments":{"command":"echo</tool_call>' } },
            { type: 'message_complete', payload: { text: '' } },
          ]
        }
        return defaultScript(p)
      },
    }, async ({ call, wire }) => {
      const u1 = { role: 'user', content: 'run it' }
      const r1 = await call({ model: 'fast', messages: [u1], tools: [fnTool('Bash')] })
      const message = r1.response.json.choices[0].message
      const r2 = await call({
        model: 'fast',
        tools: [fnTool('Bash')],
        messages: [
          u1,
          { role: 'assistant', content: message.content, tool_calls: message.tool_calls },
          { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'Error: No such tool available: aws_quick_invalid_tool_call' },
        ],
      })
      return { wire: wire(), responses: [r1, r2] }
    })
  },

  'streaming reply (chunks, reasoning, usage)': async (impl, identity) => withFake(impl, identity, {}, async ({ call, wire }) => {
    const responses = [await call({ model: 'fast', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hello' }] })]
    return { wire: wire(), responses }
  }),

  'pseudo-200 quota sentence fails as 429': async (impl, identity) => {
    return withFake(impl, identity, {
      script: () => [
        { type: 'text_delta', payload: { delta: PSEUDO200.slice(0, 30) } },
        { type: 'text_delta', payload: { delta: PSEUDO200.slice(30) } },
        { type: 'message_complete', payload: { text: PSEUDO200 } },
      ],
    }, async ({ call, wire }) => {
      const responses = [await call({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] })]
      return { wire: wire(), responses }
    })
  },
}

// Self-checks: a scenario that stops exercising its path would compare two
// identical trivial runs and "pass". Each check asserts the TS capture really
// contains the feature the scenario is about.
const text = (run, i) => String(run.wire[i]?.payload?.text ?? '')
const CHECKS = {
  'fresh thread with tools (non-stream)': (run) => {
    assert.equal(run.wire.length, 1)
    assert.match(text(run, 0), /Tools provided by the client/)
    assert.equal(run.wire[0].payload.web_search_enabled, false)
    assert.match(String(run.wire[0].payload.custom_prompt), /Reply formatting/)
  },
  'reused thread + tool result (non-stream)': (run) => {
    assert.equal(run.wire.length, 2)
    assert.equal(run.wire[1].thread, run.wire[0].thread, 'thread is reused')
    assert.match(text(run, 1), /Client tool calling — reminder/)
    assert.ok(!text(run, 1).includes('Tools provided by the client'), 'no full spec on reuse')
  },
  'oversize transcript becomes an attachment (stream), then reuses': (run) => {
    assert.equal(run.wire.length, 2)
    assert.equal(run.wire[1].thread, run.wire[0].thread, 'the noted turn is continued on the same thread')
    const atts = run.wire[0].payload.attachments ?? []
    assert.ok(atts.some((a) => a.type === 'file' && a.mimeType === 'text/plain'), 'transcript uploaded as a file')
    assert.match(text(run, 0), /attached file context_<rand>\.txt/)
    assert.match(JSON.stringify(run.responses[0].response), /附件/)
    assert.ok(!JSON.stringify(run.responses[1].response).includes('附件'), 'the note is not repeated once the thread continues')
  },
  'inline image stays inline (non-stream)': (run) => {
    const atts = run.wire[0].payload.attachments ?? []
    assert.ok(atts.some((a) => a.type === 'image' && a.data), 'small image rides inline')
  },
  'guardrail stop is retried on the same thread': (run) => {
    assert.equal(run.wire.length, 2, 'blocked attempt + retry')
    assert.equal(run.wire[1].thread, run.wire[0].thread, 'retry stays on the thread')
    assert.match(text(run, 1), /Continue the previous request/)
  },
  'dead cached thread retries on a fresh thread': (run) => {
    assert.equal(run.wire.length, 3)
    assert.equal(run.wire[1].thread, run.wire[0].thread)
    assert.notEqual(run.wire[2].thread, run.wire[1].thread, 'retry is a new thread')
    assert.match(text(run, 2), /first task/)
    assert.match(text(run, 2), /Tools provided by the client/, 'full spec again on the fresh retry')
  },
  'guardrail budget spent surfaces the labelled error': (run) => {
    assert.equal(run.wire.length, 2, 'one retry, then stop')
    assert.equal(run.wire[1].thread, run.wire[0].thread)
    assert.match(run.responses[0].response.json.error.message, /审核拦截/)
  },
  'guardrail on the fresh retry surfaces as-is (no second retry)': (run) => {
    assert.equal(run.wire.length, 3, 'no attempt after the fresh retry')
    assert.notEqual(run.wire[2].thread, run.wire[1].thread)
    assert.match(run.responses[1].response.json.error.message, /审核拦截/)
  },
  'invalid <tool_call> becomes the placeholder, then is restated': (run) => {
    assert.equal(run.responses[0].response.json.choices[0].message.tool_calls[0].function.name, 'aws_quick_invalid_tool_call')
    assert.match(text(run, 1), /was not valid JSON/)
  },
  'streaming reply (chunks, reasoning, usage)': (run) => {
    const frames = run.responses[0].response.stream
    assert.equal(frames.at(-1), '[DONE]')
    assert.ok(frames.some((f) => f.choices?.[0]?.delta?.content?.includes('echo:')), 'reply chunks present')
    assert.ok(frames.some((f) => f.usage), 'include_usage honoured')
  },
  'pseudo-200 quota sentence fails as 429': (run) => {
    assert.equal(run.responses[0].status, 429)
    assert.match(run.responses[0].response.json.error.message, /usage limit/)
  },
}

// ------------------------------------------------------------------ diff ----
function firstDiff(a, b, p = '$') {
  if (Object.is(a, b)) return null
  if (typeof a !== typeof b) return { path: p, a, b }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return { path: p, a: ka, b: kb }
    for (const k of ka) {
      const d = firstDiff(a[k], b[k], `${p}.${k}`)
      if (d) return d
    }
    return null
  }
  return { path: p, a, b }
}

const clip = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s == null ? String(v) : s.length > 240 ? `${s.slice(0, 240)}…(${s.length} chars)` : s
}

function deepEqual(a, b) {
  const d = firstDiff(a, b)
  if (!d) return true
  console.log(`  first diff at ${d.path}`)
  console.log(`    ts : ${clip(d.a)}`)
  console.log(`    ref: ${clip(d.b)}`)
  return false
}

let failed = 0
let knownDiffs = 0
for (const [name, run] of Object.entries(SCENARIOS)) {
  const tag = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
  const tsRun = normalizeRun(await run(TS, `diff-${tag}-ts`))
  const refRun = normalizeRun(await run(REF, `diff-${tag}-ref`))
  try { CHECKS[name](tsRun) } catch (e) {
    failed++
    console.log(`FAIL ${name} (scenario no longer exercises its path)`)
    console.log(`  ${e.message}`)
    continue
  }
  const diff = firstDiff(tsRun, refRun)
  if (!diff) {
    console.log(`ok   ${name}  (${tsRun.wire.length} frame(s), ${tsRun.responses.length} response(s))`)
  } else if (KNOWN_DIFFS[name]) {
    knownDiffs++
    console.log(`known ${name}`)
    console.log(`  intentional: ${KNOWN_DIFFS[name]}`)
    console.log(`  first diff at ${diff.path}`)
  } else {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`  first diff at ${diff.path}`)
    console.log(`    ts : ${clip(diff.a)}`)
    console.log(`    ref: ${clip(diff.b)}`)
  }
}

if (failed) {
  console.log(`\n${failed} scenario(s) differ — behaviour changed; explain each or fix it.`)
  process.exit(1)
}
const total = Object.keys(SCENARIOS).length
console.log(`\n${total - knownDiffs} of ${total} scenarios identical, ${knownDiffs} known intentional diff(s)`)
