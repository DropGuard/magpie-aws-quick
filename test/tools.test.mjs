import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTools, buildToolPreamble, createToolCallParser, slimSchema, createSourcesStripper } from '../src/tools.ts'
import { byteLen } from '../src/translate.ts'

test('normalizeTools keeps only named function tools', () => {
  const tools = normalizeTools([
    { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'no_params' } },
    { type: 'bogus' },
    null,
  ])
  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, 'get_weather')
  assert.equal(tools[1].parameters.type, 'object') // defaulted
})

test('buildToolPreamble embeds specs and forced choice', () => {
  const tools = normalizeTools([{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }])
  const p = buildToolPreamble(tools, 'required')
  assert.ok(p.includes('<function_calls>') && p.includes('<invoke name="<tool_name>">'))
  assert.ok(p.includes('- f: d'))
  assert.ok(p.includes('reply with <invoke> block(s) only'))
  assert.equal(buildToolPreamble([], 'auto'), '')
  const named = buildToolPreamble(tools, { type: 'function', function: { name: 'f' } })
  assert.ok(named.includes('requires the client tool "f"'))
})

test('slimSchema strips annotation keywords, keeps structure', () => {
  const slim = slimSchema({
    type: 'object',
    description: 'verbose docs',
    title: 'T',
    required: ['a'],
    properties: {
      a: { type: 'string', description: 'field doc', enum: ['x', 'y'] },
      b: { type: 'object', properties: { c: { type: 'number', examples: [1] } } },
    },
  })
  assert.equal(slim.description, undefined)
  assert.equal(slim.title, undefined)
  assert.deepEqual(slim.required, ['a'])
  assert.equal(slim.properties.a.description, undefined)
  assert.deepEqual(slim.properties.a.enum, ['x', 'y'])
  assert.equal(slim.properties.b.properties.c.examples, undefined)
})

test('preamble compacts schema annotations and caps giant schemas', () => {
  const bigProps = {}
  for (let i = 0; i < 200; i++) {
    bigProps[`field_${i}`] = { type: 'string', description: 'd'.repeat(80) }
  }
  const tools = normalizeTools([
    { type: 'function', function: { name: 'small', description: 's', parameters: { type: 'object', properties: { x: { type: 'string', description: 'doc' } } } } },
    { type: 'function', function: { name: 'huge', description: 'h', parameters: { type: 'object', properties: bigProps, required: ['field_0'] } } },
  ])
  const p = buildToolPreamble(tools, 'auto')
  // small tool keeps its (slimmed) schema incl. type info
  assert.ok(p.includes('"x":{"type":"string"}'))
  assert.ok(!p.includes('"doc"')) // property description stripped
  // huge tool degrades to bare object + required
  assert.ok(p.includes('"properties":{}'))
  assert.ok(p.includes('"required":["field_0"]'))
  assert.ok(!p.includes('field_1'))
})

test('preamble falls back to name+description when toolset is enormous', () => {
  const tools = normalizeTools(Array.from({ length: 60 }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}`,
      description: `description ${i} `.repeat(30),
      parameters: { type: 'object', properties: Object.fromEntries(Array.from({ length: 15 }, (_, j) => [`p${j}`, { type: 'string', description: 'x'.repeat(60) }])) },
    },
  })))
  const p = buildToolPreamble(tools, 'auto')
  assert.ok(byteLen(p) < 45 * 1024)
  assert.ok(p.includes('parameter schemas omitted'))
  assert.ok(p.includes('- tool_0:'))
  assert.ok(!p.includes('"properties"'))
})

test('parser extracts an invoke split across deltas', () => {
  const p = createToolCallParser({ tools: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }] })
  let r = p.push('Hello <function_calls><invoke name="get_weather"><parameter name="city">Paris</parameter>')
  assert.equal(r.text, 'Hello ')
  assert.equal(r.calls.length, 0)
  r = p.push('</invoke></function_calls> done')
  assert.equal(r.text, ' done')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].name, 'get_weather')
  assert.deepEqual(r.calls[0].arguments, { city: 'Paris' })
  assert.equal(p.end().dropped, undefined)
})

test('parser handles multiple invokes, an optional wrapper, and surrounding text', () => {
  const p = createToolCallParser()
  const r = p.push('pre <function_calls><invoke name="a"></invoke><invoke name="b"><parameter name="x">1</parameter></invoke></function_calls> mid <invoke name="c"></invoke> post')
  assert.equal(r.text, 'pre  mid  post')
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'b', 'c'])
  assert.deepEqual(r.calls[1].arguments, { x: '1' })
})

test('a missing wrapper close after a complete invoke is not a dropped call', () => {
  const p = createToolCallParser()
  const r = p.push('<function_calls><invoke name="f"><parameter name="a">1</parameter></invoke>')
  assert.equal(r.calls.length, 1)
  const end = p.end()
  assert.equal(end.dropped, undefined)
})

test('parser holds back a split opening tag across deltas', () => {
  const p = createToolCallParser()
  let r = p.push('pre<')
  assert.equal(r.text, 'pre')
  assert.equal(r.calls.length, 0)
  r = p.push('invoke name="f"></invoke>post')
  assert.equal(r.text, 'post')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].name, 'f')
})

test('parser holds back a split closing tag', () => {
  const p = createToolCallParser()
  p.push('<invoke name="f"><parameter name="a">1</parameter></inv')
  const r = p.push('oke>tail')
  assert.equal(r.text, 'tail')
  assert.equal(r.calls.length, 1)
})

test('parser drops an unterminated invoke without leaking it', () => {
  const p = createToolCallParser()
  const r = p.push('text <invoke name="x"><parameter name="a">1')
  assert.equal(r.text, 'text ')
  const end = p.end()
  assert.equal(end.text, '')
  assert.equal(end.dropped, 'unterminated')
})

test('parser unescapes XML entities, keeps quotes and heredocs verbatim', () => {
  const p = createToolCallParser({
    tools: [{ name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
  })
  const r = p.push('<invoke name="Bash"><parameter name="command">grep -n "arch" Makefile &amp;&amp; echo &lt;ok&gt;</parameter></invoke>')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].arguments.command, 'grep -n "arch" Makefile && echo <ok>')
})

test('parser coerces parameter text to the schema type', () => {
  const p = createToolCallParser({
    tools: [{
      name: 'Do',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer' },
          ratio: { type: 'number' },
          deep: { type: 'boolean' },
          opts: { type: 'object' },
          list: { type: 'array' },
          name: { type: 'string' },
        },
      },
    }],
  })
  const r = p.push('<invoke name="Do"><parameter name="limit">10</parameter><parameter name="ratio">1.5</parameter><parameter name="deep">true</parameter><parameter name="opts">{"a":1}</parameter><parameter name="list">[1,2]</parameter><parameter name="name">10</parameter></invoke>')
  assert.deepEqual(r.calls[0].arguments, { limit: 10, ratio: 1.5, deep: true, opts: { a: 1 }, list: [1, 2], name: '10' })
})

test('parser marks malformed invokes invalid', () => {
  const p = createToolCallParser()
  const r = p.push('<invoke><parameter name="a">1</parameter></invoke>ok')
  assert.equal(r.calls.length, 0)
  assert.equal(r.text, 'ok')
  assert.equal(p.end().dropped, 'invalid')
  const q = createToolCallParser()
  q.push('<invoke name="f">not a parameter</invoke>')
  assert.equal(q.end().dropped, 'invalid')
})

test('the old Hermes JSON marker is not a tool call any more', () => {
  const p = createToolCallParser()
  const r = p.push('<tool_call>{"name":"f","arguments":{}}</tool_call>tail')
  assert.equal(r.calls.length, 0)
  assert.ok(r.text.includes('<tool_call>'))
  assert.ok(r.text.endsWith('tail'))
})

test('sources stripper drops only citation-only blocks outside code; XML <sources> survives', () => {
  const run = (text, step = 1) => {
    const st = createSourcesStripper()
    let out = ''
    for (let i = 0; i < text.length; i += step) out += st.push(text.slice(i, i + step))
    return out + st.end()
  }
  // citation-only blocks go, split across deltas or not
  assert.equal(run('Done.\n<sources> [numeric tool args](mem://d5e9) </sources>\n\nNext <option>'), 'Done.\n\n\nNext <option>')
  assert.equal(run('a<sources>[x](mem://1), [y](https://e.com/p)</sources>b', 3), 'ab')
  // a real XML <sources> element survives
  const maven = '<sources>\n  <source>src/gen/java</source>\n</sources>'
  assert.equal(run(`Add:\n${maven}\n`), `Add:\n${maven}\n`)
  // even a citation-shaped block is kept inside a code fence
  const fenced = '```md\n<sources>[x](mem://1)</sources>\n```\nafter<sources>[y](mem://2)</sources>'
  assert.equal(run(fenced), '```md\n<sources>[x](mem://1)</sources>\n```\nafter')
  // unclosed / oversized blocks pass through verbatim
  assert.equal(run('a <sources>never closed'), 'a <sources>never closed')
  const big = '<sources>' + 'x'.repeat(5000)
  assert.equal(run(big, 97), big)
})
