// OpenAI tools ⇄ Quick text convention.
//
// Quick's bidi protocol has no client-tool channel: its agent runtime owns the
// tool loop and executes ITS tools server-side (verified live — tool_start/
// tool_arguments/tool_result events, message_complete.tool_calls stays empty).
// But the underlying model will happily emit a caller-defined convention as
// plain text when the instruction is strong and inline (verified: a MANDATORY
// block in the user text produced exactly `<tool_call>{json}</tool_call>`).
//
// So we inject tool specs + rules into the message text, parse
// <tool_call>{"name":…,"arguments":{…}}</tool_call> blocks out of the streamed
// text, and surface them as OpenAI tool_calls. Results come back as role:'tool'
// messages, rendered into the next turn's text by renderDelta.

import { byteLen } from './translate.ts'

/** OpenAI tools[] → compact spec list (function tools only). */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  const out: any[] = []
  for (const t of tools) {
    const fn = t?.function ?? t
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue
    // OpenAI uses `parameters`; Anthropic-style shims may send `input_schema`.
    const schema = fn.parameters ?? fn.input_schema
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} },
    })
  }
  return out
}

function toolSpecLine(t, descCap = Infinity) {
  const params = JSON.stringify(boundedParameters(t))
  let desc = t.description || '(no description)'
  if (Number.isFinite(descCap) && desc.length > descCap) desc = desc.slice(0, descCap) + '…'
  return `- ${t.name}: ${desc}\n  parameters: ${params}`
}

// JSON-Schema annotation keywords that cost bytes but carry no structure.
const SCHEMA_ANNOTATIONS = new Set([
  'description', 'title', 'examples', 'example', 'default', '$comment',
  'deprecated', 'readOnly', 'writeOnly', 'markdownDescription',
])
const SCHEMA_NESTED = new Set(['properties', 'patternProperties', '$defs', 'definitions'])
const SCHEMA_SINGLE = new Set(['items', 'additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not'])
const SCHEMA_ARRAY = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])

/** Strip annotation keywords recursively; keeps types/required/enum/structure. */
export function slimSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8) return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (SCHEMA_ANNOTATIONS.has(k)) continue
    if (SCHEMA_NESTED.has(k) && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, slimSchema(pv, depth + 1)]))
    } else if (SCHEMA_SINGLE.has(k) && v && typeof v === 'object') {
      out[k] = slimSchema(v, depth + 1)
    } else if (SCHEMA_ARRAY.has(k) && Array.isArray(v)) {
      out[k] = v.map((x) => slimSchema(x, depth + 1))
    } else {
      out[k] = v
    }
  }
  return out
}

/** Per-tool schema cap: beyond this, degrade to a bare object schema. */
const SCHEMA_CAP = 3072

function boundedParameters(t) {
  const slim = slimSchema(t.parameters)
  const json = JSON.stringify(slim)
  if (json.length <= SCHEMA_CAP) return slim
  // Still too big: keep only the top-level shape so the model knows it takes an object.
  const required = Array.isArray(t.parameters?.required) ? t.parameters.required : []
  return { type: 'object', properties: {}, ...(required.length ? { required } : {}) }
}

/**
 * The instruction block prepended to the text we send upstream.
 * @param {Array} tools normalized tools (may be empty → returns '')
 * @param {string|object} [toolChoice] body.tool_choice
 */
// Quick rejects user_message.text over 64 KB; a huge toolset alone can eat
// most of that, so the preamble degrades to name+description when needed.
const PREAMBLE_CAP = 40 * 1024

export function buildToolPreamble(tools, toolChoice, { lite = false, namesOnly = false, reminder = false, descCap = Infinity } = {}) {
  if (!tools.length) return ''
  // OpenAI: 'auto'|'required'|'none'|{type:'function',function:{name}}
  // Anthropic-style shims: {type:'auto'|'any'|'none'|'tool', name?}
  const tc = typeof toolChoice === 'object' && toolChoice !== null ? toolChoice : null
  const openAiName = tc?.function?.name
  const anthropicName = tc?.type === 'tool' ? tc.name : undefined
  const forced = openAiName ?? anthropicName
    ?? (toolChoice === 'required' || tc?.type === 'any' ? true : false)
  const only = typeof forced === 'string' ? tools.filter((t) => t.name === forced) : tools
  const shown = only.length ? only : tools
  const must = forced
    ? only.length === 1 && typeof forced === 'string'
      ? `This request requires the client tool "${forced}" — reply with only its <tool_call> block.`
      : 'This request requires a client tool — reply with <tool_call> block(s) only.'
    : ''
  // Reused threads already carry the full spec in Quick's server-side
  // history, and everything sent in `text` stays there: re-sending a 30 KB
  // spec every turn grew the reported context ~10k tokens per request and
  // made Claude Code auto-compact after a couple of questions. Keep only a
  // short reminder so the convention stays salient.
  if (reminder) {
    return [
      '[Client tool calling — reminder]',
      `The client tools described earlier in this conversation are still available: ${shown.slice(0, 80).map((t) => t.name).join(', ')}.`,
      'To call one, reply with ONLY <tool_call>{"name":"<tool_name>","arguments":{<json arguments>}}</tool_call> block(s), no other text; after a [tool_result …] message arrives, continue in plain text.',
      must,
    ].filter(Boolean).join('\n')
  }
  const assemble = (specs, header) => [
    '[Client tool calling]',
    'The application you are assisting exposes the tools below; it executes them on the user\'s machine and returns each result as a [tool_result …] message.',
    'This channel has no native function-calling API — the <tool_call> marker below is the only way to invoke these tools.',
    'When the task needs one of them, reply with ONLY a block in this format (no other text):',
    '<tool_call>{"name":"<tool_name>","arguments":{<json arguments>}}</tool_call>',
    'Guidelines:',
    '- one block per call; several blocks are allowed for parallel calls;',
    '- "arguments" is a JSON object matching the parameters schema;',
    '- after a [tool_result …] message arrives, continue the task in plain text;',
    '- earlier [tool_result …] blocks may be truncated or omitted; when the task needs current file or command output, call the tools again instead of guessing from memory;',
    must,
    header,
    specs,
  ].filter(Boolean).join('\n')
  // Lite/names tiers cap each description — verbose tool docs otherwise keep
  // the "lite" preamble in the tens of KB and it still gets shed downstream.
  const desc = (t) => String(t.description || '(no description)').slice(0, 200)
  const liteSpecs = shown.map((t) => `- ${t.name}: ${desc(t)}`).join('\n')
  const namesSpecs = shown.map((t) => `- ${t.name}`).join('\n')
  const liteHeader = 'Tools provided by the client (parameter schemas omitted — use the tool name and reasonable arguments):'
  const namesHeader = 'Tools provided by the client (names only — infer arguments from each tool\'s purpose):'
  let out = namesOnly
    ? assemble(namesSpecs, namesHeader)
    : lite
      ? assemble(liteSpecs, liteHeader)
      : assemble(shown.map((t) => toolSpecLine(t, descCap)).join('\n'), 'Tools provided by the client:')
  if (!lite && !namesOnly && byteLen(out) > PREAMBLE_CAP) {
    // 20+ Claude-Code-sized schemas can exceed the 64 KB message cap on their
    // own — keep names + descriptions, drop parameter schemas entirely.
    out = assemble(liteSpecs, liteHeader)
  }
  return out
}

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'
const OPEN_RE = /<tool_call>/g
const CLOSE_RE = /<\/tool_call>/g

/** Longest suffix of `buf` that is a proper prefix of `tag` (0 if none). */
function heldPrefixLen(buf, tag) {
  const max = Math.min(buf.length, tag.length - 1)
  for (let k = max; k >= 1; k--) {
    if (buf.endsWith(tag.slice(0, k))) return k
  }
  return 0
}

/**
 * Incremental parser: feed text_delta strings, get back visible text and
 * completed tool calls. Blocks split across deltas are handled — including a
 * tag split mid-token (`<` + `tool_call>…`), which is held back rather than
 * flushed. A dangling <tool_call> at end() is reported via `dropped` ('unterminated'; an unparseable block is 'invalid').
 */
export function createToolCallParser() {
  let buf = ''
  let inBlock = false
  let blockJson = ''
  let dropped: string | false = false
  let droppedName = ''
  const pending: any[] = [] // parsed calls waiting for id assignment

  const drain = () => {
    const text: string[] = []
    const calls: any[] = []
    for (;;) {
      if (!inBlock) {
        OPEN_RE.lastIndex = 0
        const m = OPEN_RE.exec(buf)
        if (!m) {
          // Hold back a suffix that could be the start of <tool_call>.
          const hold = heldPrefixLen(buf, OPEN_TAG)
          text.push(buf.slice(0, buf.length - hold))
          buf = buf.slice(buf.length - hold)
          break
        }
        text.push(buf.slice(0, m.index))
        buf = buf.slice(m.index + m[0].length)
        inBlock = true
        blockJson = ''
        continue
      }
      CLOSE_RE.lastIndex = 0
      const m = CLOSE_RE.exec(buf)
      if (!m) {
        // Same holdback for a split </tool_call> — keep it out of blockJson.
        const hold = heldPrefixLen(buf, CLOSE_TAG)
        blockJson += buf.slice(0, buf.length - hold)
        buf = buf.slice(buf.length - hold)
        break
      }
      blockJson += buf.slice(0, m.index)
      buf = buf.slice(m.index + m[0].length)
      inBlock = false
      const call = parseCall(blockJson)
      if (call) calls.push(call)
      else { dropped ||= 'invalid'; droppedName ||= guessName(blockJson) }
      blockJson = ''
    }
    return { text: text.join(''), calls }
  }

  return {
    /** Feed a delta; returns {text, calls:[{name, arguments(object)}]}. */
    push(delta) {
      if (!delta) return { text: '', calls: [] }
      buf += delta
      const r = drain()
      for (const c of r.calls) pending.push(c)
      return { text: r.text, calls: r.calls }
    },
    /** Flush at stream end. Returns {text, calls, dropped}. */
    end() {
      const r = drain()
      for (const c of r.calls) pending.push(c)
      let tail = r.text
      if (inBlock) {
        // unterminated block → not shown to the user
        dropped ||= 'unterminated'
        droppedName ||= guessName(blockJson)
        inBlock = false
        blockJson = ''
        buf = ''
      } else if (buf) {
        // held-back tag prefix at EOS is just literal text
        tail += buf
        buf = ''
      }
      return { text: tail, calls: r.calls, dropped: dropped || undefined, droppedName: droppedName || undefined }
    },
    /** All calls seen so far (for session bookkeeping). */
    get calls() { return pending },
  }
}

/** Best-effort tool name out of a block that failed to parse. */
function guessName(json) {
  const m = /"name"\s*:\s*"([^"\\]{1,128})"/.exec(json)
  return m ? m[1] : ''
}

function parseCall(json) {
  let obj
  // The model sometimes wraps the JSON in stray markup — a ```json fence or
  // an Anthropic-style `</invoke>` before </tool_call> (seen live on a 6 KB
  // Bash heredoc) — or writes raw newlines/tabs inside long string values
  // (file contents, heredocs). Try as-is, then the outermost {…} span, each
  // also with raw control characters escaped.
  const a = json.indexOf('{')
  const b = json.lastIndexOf('}')
  const span = a >= 0 && b > a ? json.slice(a, b + 1) : null
  for (const cand of [json.trim(), span, escapeRawControls(json.trim()), span && escapeRawControls(span)]) {
    if (!cand) continue
    try { obj = JSON.parse(cand); break } catch {}
  }
  if (obj === undefined) return null
  const name = obj?.name ?? obj?.tool ?? obj?.function?.name
  if (typeof name !== 'string' || !name) return null
  let args = obj.arguments ?? obj.args ?? obj.input ?? obj.parameters ?? {}
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { /* keep string */ }
  }
  if (args == null || typeof args !== 'object') args = {}
  return { name, arguments: args }
}

/** Assign OpenAI-style ids to parsed calls: call_<rand>. */
export function withCallIds(calls) {
  return calls.map((c) => ({
    id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }))
}

const CTRL_ESC = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }

/** Escape raw control characters that sit inside JSON string literals. */
export function escapeRawControls(s) {
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      else if (ch < ' ') { out += CTRL_ESC[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; continue }
    } else if (ch === '"') inStr = true
    out += ch
  }
  return out
}

// A Quick citation block holds nothing but markdown links, e.g.
// `<sources> [numeric tool args](mem://d5e9…) </sources>`. A real XML
// <sources> element (Maven build-helper's <sources><source>…) never does.
const CITATIONS_ONLY = /^\s*(?:\[[^\]\n]*\]\([^)\s]+\)[\s,;]*)+$/
const SOURCES_SCAN_CAP = 4096

/**
 * Streaming remover for Quick-app citation blocks that the prompt note alone
 * doesn't always suppress. Conservative: a `<sources>…</sources>` block is
 * dropped only when it sits outside a ``` code fence AND contains nothing
 * but markdown links; anything else (XML, prose, an unclosed or oversized
 * block) passes through verbatim.
 * push(delta) → visible text; end() → whatever was still held back.
 */
export function createSourcesStripper() {
  const OPEN = '<sources>'
  const CLOSE = '</sources>'
  let buf = ''
  let inBlock = false
  let inner = ''
  let inFence = false
  const emit = (s) => {
    // Track ``` fences in what actually goes out, so blocks inside code are kept.
    const n = s.split('```').length - 1
    if (n % 2) inFence = !inFence
    return s
  }
  const drain = () => {
    let out = ''
    for (;;) {
      if (!inBlock) {
        const i = inFence ? -1 : buf.indexOf(OPEN)
        const fence = buf.indexOf('```')
        if (fence >= 0 && (i < 0 || fence < i)) {
          // emit through the fence marker so the fence state flips first
          out += emit(buf.slice(0, fence + 3))
          buf = buf.slice(fence + 3)
          continue
        }
        if (i < 0) {
          const hold = Math.max(inFence ? 0 : heldPrefixLen(buf, OPEN), heldPrefixLen(buf, '```'))
          out += emit(buf.slice(0, buf.length - hold))
          buf = buf.slice(buf.length - hold)
          return out
        }
        out += emit(buf.slice(0, i))
        buf = buf.slice(i + OPEN.length)
        inBlock = true
        inner = ''
      }
      const j = buf.indexOf(CLOSE)
      if (j < 0) {
        const hold = heldPrefixLen(buf, CLOSE)
        inner += buf.slice(0, buf.length - hold)
        buf = buf.slice(buf.length - hold)
        if (inner.length > SOURCES_SCAN_CAP) {
          // too long to be a citation list: give it back untouched
          out += emit(OPEN + inner)
          inBlock = false
          inner = ''
          continue
        }
        return out
      }
      inner += buf.slice(0, j)
      buf = buf.slice(j + CLOSE.length)
      inBlock = false
      if (!CITATIONS_ONLY.test(inner)) out += emit(OPEN + inner + CLOSE)
      inner = ''
    }
  }
  return {
    push(delta) { buf += delta || ''; return drain() },
    end() {
      let out = drain()
      if (inBlock) out += emit(OPEN + inner + buf)
      else out += emit(buf)
      buf = ''
      inner = ''
      inBlock = false
      return out
    },
  }
}
