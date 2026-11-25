// OpenAI tools ⇄ Quick text convention.
//
// Quick's bidi protocol has no client-tool channel: its agent runtime owns the
// tool loop and executes ITS tools server-side (verified live — tool_start/
// tool_arguments/tool_result events, message_complete.tool_calls stays empty).
// But the underlying model will happily emit a caller-defined convention as
// plain text when the instruction is strong and inline. The dialect is
// Anthropic-style XML — <function_calls><invoke name="…"><parameter
// name="…">value</parameter></invoke></function_calls> — because Claude models
// know it and it needs no JSON escaping for shell commands or file contents.
//
// So we inject tool specs + rules into the message text, parse <invoke> blocks
// out of the streamed text, and surface them as OpenAI tool_calls. Results come
// back as role:'tool' messages, rendered as <tool_result> blocks.

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
      ? `This request requires the client tool "${forced}" — reply with only its <invoke name="${forced}"> block.`
      : 'This request requires a client tool — reply with <invoke> block(s) only.'
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
      'To call one, reply with ONLY <function_calls><invoke name="<tool_name>"><parameter name="<arg_name>">value</parameter></invoke></function_calls>, no other text; after a <tool_result …> block arrives, continue in plain text.',
      'Parameter values are plain text (no JSON escaping); for an object or array argument, put its JSON inside the parameter.',
      must,
    ].filter(Boolean).join('\n')
  }
  const assemble = (specs, header) => [
    '[Client tool calling]',
    'The application you are assisting exposes the tools below; it executes them on the user\'s machine and returns each result as a <tool_result …> block.',
    'This channel has no native function-calling API — the <invoke> block below is the only way to invoke these tools.',
    'When the task needs one of them, reply with ONLY a <function_calls> block in this format (no other text):',
    '<function_calls>\n<invoke name="<tool_name>">\n<parameter name="<arg_name>">value</parameter>\n</invoke>\n</function_calls>',
    'Guidelines:',
    '- one <invoke> per call; several are allowed inside one <function_calls> for parallel calls;',
    '- each argument is one <parameter name="...">value</parameter>; the value is plain text, no JSON escaping; for an object or array argument put its JSON inside the parameter;',
    '- after a <tool_result …> block arrives, continue the task in plain text;',
    '- earlier <tool_result …> blocks may be truncated or omitted; when the task needs current file or command output, call the tools again instead of guessing from memory;',
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

const WRAP_OPEN = '<function_calls'
const WRAP_CLOSE = '</function_calls>'
const CALL_OPEN = '<invoke'
const CALL_CLOSE = '</invoke>'

/** Longest suffix of `buf` that is a proper prefix of `tag` (0 if none). */
function heldPrefixLen(buf, tag) {
  const max = Math.min(buf.length, tag.length - 1)
  for (let k = max; k >= 1; k--) {
    if (buf.endsWith(tag.slice(0, k))) return k
  }
  return 0
}

/** Value of an XML attribute (`name="Bash"`, `name='Bash'`, or bare). */
function attrValue(attrs, key) {
  const re = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = re.exec(attrs)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
}

/** XML text → plain text (named and numeric entities). */
export function xmlUnescape(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Coerce a parameter's text to the type its tool schema declares. */
function coerceValue(value, schema) {
  if (!schema || typeof schema !== 'object') return value
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type
  switch (type) {
    case 'integer': {
      const n = Number(String(value).trim())
      return Number.isInteger(n) ? n : value
    }
    case 'number': {
      const n = Number(String(value).trim())
      return Number.isFinite(n) ? n : value
    }
    case 'boolean': {
      const v = String(value).trim().toLowerCase()
      if (v === 'true' || v === '1') return true
      if (v === 'false' || v === '0') return false
      return value
    }
    case 'array':
    case 'object': {
      try { return JSON.parse(String(value)) } catch { return value }
    }
    case 'null':
      return String(value).trim() === '' || String(value).trim().toLowerCase() === 'null' ? null : value
    default:
      return value
  }
}

/** Parse one `<invoke>` body into {name, arguments}; null when malformed. */
function parseInvoke(inner, name, schemas) {
  if (!name) return null
  const args = {}
  const re = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi
  let m
  while ((m = re.exec(inner))) {
    const pname = attrValue(m[1], 'name')
    if (!pname) return null
    const schema = schemas.get(String(name).toLowerCase())?.properties?.[pname]
    args[pname] = coerceValue(xmlUnescape(m[2]), schema)
  }
  // anything left must be whitespace: an unclosed parameter or prose is invalid
  const rest = inner.replace(/<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi, '')
  if (/<parameter\b/i.test(rest) || rest.replace(/\s+/g, '')) return null
  return { name, arguments: args }
}

function guessInvokeName(s) {
  const m = /<invoke\b([^>]*)/i.exec(String(s ?? ''))
  return m ? attrValue(m[1], 'name') : ''
}

/**
 * Incremental parser for Anthropic-style XML tool calls:
 *
 *   <function_calls>
 *   <invoke name="Bash">
 *   <parameter name="command">git status --porcelain</parameter>
 *   </invoke>
 *   </function_calls>
 *
 * The wrapper is optional. Parameter values are plain text (XML entities
 * unescaped); an object/array parameter is JSON inside the parameter, coerced
 * to its declared schema type. Text outside calls is returned as visible text.
 * A call that is still open at end() is `unterminated`; a malformed invoke or
 * parameter is `invalid`.
 */
export function createToolCallParser({ tools = [] }: { tools?: any[] } = {}) {
  const schemas = new Map((tools ?? []).map((t) => [String(t.name).toLowerCase(), t.parameters]))
  let buf = ''
  let inWrapper = false
  let inCall = false
  let callName = ''
  let callBody = ''
  let dropped: string | false = false
  let droppedName = ''
  const pending: any[] = []
  let parsed: any[] = []

  const openCall = (tag) => {
    callName = attrValue(tag, 'name')
    inCall = true
    callBody = ''
  }
  const closeCall = () => {
    const call = parseInvoke(callBody, callName, schemas)
    inCall = false
    if (call) parsed.push(call)
    else { dropped ||= 'invalid'; droppedName ||= callName || guessInvokeName(callBody) }
    callName = ''
    callBody = ''
  }
  const drain = () => {
    const text: string[] = []
    parsed = []
    for (;;) {
      if (inCall) {
        const idx = buf.indexOf(CALL_CLOSE)
        if (idx < 0) {
          const hold = heldPrefixLen(buf, CALL_CLOSE)
          callBody += buf.slice(0, buf.length - hold)
          buf = buf.slice(buf.length - hold)
          break
        }
        callBody += buf.slice(0, idx)
        buf = buf.slice(idx + CALL_CLOSE.length)
        closeCall()
        continue
      }
      if (inWrapper) {
        const idxCall = buf.indexOf(CALL_OPEN)
        const idxClose = buf.indexOf(WRAP_CLOSE)
        if (idxClose >= 0 && (idxCall < 0 || idxClose < idxCall)) {
          buf = buf.slice(idxClose + WRAP_CLOSE.length)
          inWrapper = false
          continue
        }
        if (idxCall >= 0) {
          const gt = buf.indexOf('>', idxCall)
          if (gt < 0) { buf = buf.slice(idxCall); break }
          const tag = buf.slice(idxCall, gt + 1)
          buf = buf.slice(gt + 1)
          openCall(tag)
          continue
        }
        const hold = Math.max(heldPrefixLen(buf, CALL_OPEN), heldPrefixLen(buf, WRAP_CLOSE))
        // wrapper content is markup + whitespace only; drop everything but a
        // possible split tag at the end
        buf = buf.slice(buf.length - hold)
        break
      }
      const idxCall = buf.indexOf(CALL_OPEN)
      const idxWrap = buf.indexOf(WRAP_OPEN)
      const idx = idxCall < 0 ? idxWrap : idxWrap < 0 ? idxCall : Math.min(idxCall, idxWrap)
      if (idx < 0) {
        const hold = Math.max(heldPrefixLen(buf, CALL_OPEN), heldPrefixLen(buf, WRAP_OPEN))
        text.push(buf.slice(0, buf.length - hold))
        buf = buf.slice(buf.length - hold)
        break
      }
      if (idx > 0) text.push(buf.slice(0, idx))
      const gt = buf.indexOf('>', idx)
      if (gt < 0) { buf = buf.slice(idx); break }
      const tag = buf.slice(idx, gt + 1)
      buf = buf.slice(gt + 1)
      if (tag.toLowerCase().startsWith(WRAP_OPEN)) inWrapper = true
      else openCall(tag)
    }
    return { text: text.join(''), calls: parsed }
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
      if (inCall) {
        dropped ||= 'unterminated'
        droppedName ||= callName || guessInvokeName(callBody)
        inCall = false
        callBody = ''
        buf = ''
      } else if (inWrapper) {
        // A missing </function_calls> after a complete invoke is cosmetic; only
        // an empty, unclosed wrapper is a dropped call.
        if (!pending.length) dropped ||= 'unterminated'
        inWrapper = false
        buf = ''
      } else if (buf) {
        if (/^<invoke\b/i.test(buf) || /^<function_calls\b/i.test(buf)) {
          dropped ||= 'unterminated'
          droppedName ||= guessInvokeName(buf)
        } else tail += buf
        buf = ''
      }
      return { text: tail, calls: r.calls, dropped: dropped || undefined, droppedName: droppedName || undefined }
    },
    /** All calls seen so far (for session bookkeeping). */
    get calls() { return pending },
  }
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
