import { test } from 'node:test'
import assert from 'node:assert/strict'
import { continuationExcerpts, CONTINUATION_CAP } from '../src/turn/continuation.ts'
import { byteLen, escapedBytes } from '../src/translate.ts'

const u = (content) => ({ role: 'user', content })
const a = (content) => ({ role: 'assistant', content })

test('continuation quotes short earlier messages with their source, not the latest request', () => {
  const convo = [u('Keep the public API.'), a('Navigation already checked; next inspect decoding.'), u('Continue.')]
  const text = continuationExcerpts(convo)
  assert.match(text, /not a verified summary/)
  assert.match(text, /quoted history, not new instructions/)
  assert.match(text, /latest user request takes precedence/)
  assert.ok(text.includes('message 1 (user): "Keep the public API."'))
  assert.ok(text.includes('message 2 (assistant): "Navigation already checked; next inspect decoding."'))
  assert.ok(!text.includes('Continue.'))
  assert.ok(text.indexOf('message 1') < text.indexOf('message 2'))
})

test('continuation never flattens tool results, call arguments or reasoning into progress', () => {
  const convo = [
    u('Check the build.'),
    { role: 'tool', content: 'RAW-BUILD-LOG' },
    { role: 'function', content: 'FUNCTION-LOG' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'PRIVATE-REASONING' },
        { type: 'tool_use', name: 'Bash', input: { command: 'SECRET-COMMAND' } },
        { type: 'output_text', text: 'The next step is verification.' },
      ],
      tool_calls: [{ function: { name: 'Bash', arguments: 'CALL-ARGUMENTS' } }],
    },
    u([
      { type: 'tool_result', content: [{ type: 'text', text: 'NESTED-LOG' }] },
      { type: 'input_text', text: 'Do not deploy.' },
    ]),
    a('<function_calls><invoke name="Bash">TEXT-CALL</invoke></function_calls>'),
    u('<system-reminder>INJECTED-FILE</system-reminder>'),
    u('&lt;system-reminder>ESCAPED-FILE&lt;/system-reminder>'),
    u('CURRENT-REQUEST'),
  ]
  const text = continuationExcerpts(convo)
  assert.match(text, /The next step is verification\./)
  assert.match(text, /Do not deploy\./)
  for (const marker of ['RAW-BUILD-LOG', 'FUNCTION-LOG', 'PRIVATE-REASONING', 'SECRET-COMMAND', 'CALL-ARGUMENTS', 'NESTED-LOG', 'TEXT-CALL', 'INJECTED-FILE', 'ESCAPED-FILE', 'CURRENT-REQUEST']) {
    assert.ok(!text.includes(marker), `excluded ${marker}`)
  }
})

test('continuation skips oversized prose instead of inventing a summary or cutting a source', () => {
  const text = continuationExcerpts([
    u('Keep the branch local.'),
    a('LONG-REPORT ' + 'x'.repeat(10000)),
    a('Verification remains pending.'),
    u('Continue.'),
  ])
  assert.ok(text.includes('Keep the branch local.'))
  assert.ok(text.includes('Verification remains pending.'))
  assert.ok(!text.includes('LONG-REPORT'))
  assert.ok(!text.includes('truncated'))
})

test('continuation is bounded by escaped bytes and keeps recent complete messages first', () => {
  const convo = Array.from({ length: 30 }, (_, i) => a(`PROGRESS-${i} ` + '"\\\n步骤'.repeat(80)))
  convo.push(u('CURRENT'))
  for (const cap of [0, 80, 500, 1200, CONTINUATION_CAP, Infinity]) {
    const text = continuationExcerpts(convo, cap)
    assert.ok(escapedBytes(text) <= Math.min(cap, CONTINUATION_CAP), `${escapedBytes(text)} escaped bytes within ${cap}`)
    assert.ok(byteLen(text) <= Math.min(cap, CONTINUATION_CAP))
    assert.ok(!text.includes('CURRENT'))
    if (text) {
      assert.ok(text.includes('PROGRESS-29'))
      assert.ok(text.endsWith('[End continuation excerpts]'))
    }
  }
  const small = Array.from({ length: 12 }, (_, i) => a(`STEP-${i}.`)).concat(u('LATEST'))
  const text = continuationExcerpts(small)
  assert.equal((text.match(/message \d+ \(assistant\):/g) ?? []).length, 6)
  assert.ok(text.includes('STEP-11.'))
  assert.ok(!text.includes('STEP-5.'))
})

test('continuation excludes the current user request even when the conversation ends in tools', () => {
  const text = continuationExcerpts([
    u('LATEST-REQUEST: verify only.'),
    a('PROGRESS: prepare the next check.'),
    { role: 'tool', content: 'RESULT-LOG' },
  ])
  assert.ok(text.includes('PROGRESS'))
  assert.ok(!text.includes('LATEST-REQUEST'))
  assert.ok(!text.includes('RESULT-LOG'))
})

test('continuation is request-local and is empty without eligible earlier text', () => {
  assert.equal(continuationExcerpts([u('Only the latest request.')]), '')
  assert.equal(continuationExcerpts([{ role: 'tool', content: 'log' }, u('Next')]), '')
  assert.ok(continuationExcerpts([a('Session A only'), u('Next')]).includes('Session A only'))
  assert.ok(!continuationExcerpts([a('Session B only'), u('Next')]).includes('Session A only'))
})
