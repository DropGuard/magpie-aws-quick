// Request-only routing hints. Never inspect account/auth metadata here.
import { createHash } from 'node:crypto'
import { canonRole, textOf } from './translate.ts'

export interface RequestOptions {
  sessionKey?: string
  subagentKey?: string
  querySource?: string
  effortHeader?: string
}

export type RequestPurpose = 'main' | 'prompt_suggestion' | 'away_summary' | 'generate_session_title'
export type RequestSource = 'header' | 'metadata' | 'prompt' | 'default'
export interface RequestContext {
  purpose: RequestPurpose
  source: RequestSource
  /** Only the three known background purposes bypass normal conversation reuse. */
  isolated: boolean
  /** Use this SAME key for turn lanes and thread-cache matching. */
  sessionKey: string
}

const AFFINITY_HEADERS = [
  'x-magpie-session', 'session_id', 'x-session-id', 'x-session-affinity',
  'x-client-request-id', 'x-thread-id', 'x-conversation-id',
]
const nonBlank = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

/**
 * Extract request headers through the caller's case-insensitive header getter.
 * First nonblank affinity header wins, in the existing index.ts order; values
 * are preserved, not truncated. x-magpie-query-source is an explicit adapter
 * convention, NOT a claim that Magpie or every gateway sends such a header.
 */
export function requestOptions(getHeader: (name: string) => string | null | undefined): RequestOptions {
  return {
    sessionKey: AFFINITY_HEADERS.map((name) => nonBlank(getHeader(name))).find((value) => value !== undefined),
    subagentKey: nonBlank(getHeader('x-magpie-subagent')),
    querySource: nonBlank(getHeader('x-magpie-query-source')),
    effortHeader: nonBlank(getHeader('x-magpie-effort')),
  }
}

type ObjectValue = Record<string, unknown>
const objectOf = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined
const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim()

function knownPurpose(value: unknown): Exclude<RequestPurpose, 'main'> | undefined {
  if (typeof value !== 'string') return undefined
  const tag = value.trim()
  if (tag === 'prompt_suggestion' || tag === 'away_summary' || tag === 'generate_session_title') return tag
  return undefined
}

const SUGGESTION_OPENING = '[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]'
const AWAY_OPENING = 'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown.'
const TITLE_IDENTITY = 'You are naming a coding session so the user can pick it out of a long list of sessions.'
const opensWith = (text: string, opening: string): boolean => text === opening || text.startsWith(`${opening} `)
const isExecutionPart = (part: unknown): boolean => {
  const type = objectOf(part)?.type
  return type === 'tool_use' || type === 'tool_result' || type === 'function_call' || type === 'function_call_output'
}

/** Only the pending user turn counts, never a prompt quoted in earlier history. */
function currentUser(body: ObjectValue): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const index = messages.findLastIndex((message) => canonRole(objectOf(message)?.role) === 'user')
  if (index < 0) return undefined
  if (messages.slice(index + 1).some((message) => {
    const role = canonRole(objectOf(message)?.role)
    return role === 'assistant' || role === 'tool' || role === 'function'
  })) return undefined
  const message = objectOf(messages[index])!
  if (Array.isArray(message.content) && message.content.some(isExecutionPart)) return undefined
  if ((Array.isArray(message.tool_calls) && message.tool_calls.length) || message.function_call) return undefined
  return normalize(textOf(message.content))
}

function hasTitleIdentity(content: unknown): boolean {
  const text = textOf(content)
  // An identity paragraph may be its own system content part. Do not search
  // arbitrary substrings: code fences, quotes and prose mentioning it are not
  // the dedicated title-generation identity.
  const paragraphs = text.split(/\r?\n[\t \u00a0]*\r?\n/u)
  if (Array.isArray(content)) paragraphs.push(...content.map((part) => textOf([part])))
  return paragraphs.some((paragraph) => opensWith(normalize(paragraph), TITLE_IDENTITY))
}

function hasTitleSchema(body: ObjectValue): boolean {
  const format = objectOf(body.response_format)
  if (format?.type !== 'json_schema') return false
  const schema = objectOf(objectOf(format.json_schema)?.schema)
  const properties = objectOf(schema?.properties)
  return schema?.type === 'object' && !!properties
    && Object.keys(properties).length === 1 && objectOf(properties.title)?.type === 'string'
    && Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === 'title'
}

function asksForOnlyTitle(content: unknown): boolean {
  const text = normalize(textOf(content)).replace(/[\u201c\u201d]/gu, '"').replace(/[\u2018\u2019]/gu, "'")
  return /\b(?:return|output|respond with) (?:only |just )?(?:the |a )?title(?: only)?(?:[.!]|$|,? (?:and )?nothing else\b)/iu.test(text)
    || /\b(?:return|output|respond with) (?:only )?(?:a )?json(?: object)? (?:with|containing) (?:only )?(?:a )?single (?:["'`]title["'`] (?:field|key|property)|(?:field|key|property)(?: named| called)?[, :]+["'`]title["'`])/iu.test(text)
}

function promptPurpose(body: ObjectValue): Exclude<RequestPurpose, 'main'> | undefined {
  const user = currentUser(body)
  if (user === undefined) return undefined
  if (opensWith(user, SUGGESTION_OPENING)) return 'prompt_suggestion'
  if (opensWith(user, AWAY_OPENING)) return 'away_summary'
  // Claude appends a title-language instruction after the closing session tag.
  if (!/^<session>\s*.+\s*<\/session>(?:\s+Write the title in .+)?$/u.test(user)) return undefined
  const systemContents: unknown[] = body.system === undefined ? [] : [body.system]
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const entry = objectOf(message)
    const role = canonRole(entry?.role)
    if (role === 'system' || role === 'developer') systemContents.push(entry?.content)
  }
  const dedicatedSystems = systemContents.filter(hasTitleIdentity)
  if (dedicatedSystems.length && (hasTitleSchema(body) || dedicatedSystems.some(asksForOnlyTitle))) return 'generate_session_title'
  return undefined
}

/**
 * Known adapter header > known body query_source/querySource > known request
 * metadata.query_source/querySource > current, fixed Claude prompt > main.
 * Unknown tags, tool availability and output-token limits are not evidence.
 * Background callers should bypass reuse/lanes when isolated=true; their key
 * is also partitioned defensively. Ordinary subagents keep reuse, but in their
 * own stable partition. Hash the FULL, unambiguous tuple before the existing
 * 128-character cache limit can discard the distinguishing suffix.
 */
export function classifyRequest(body: unknown, options: RequestOptions = {}): RequestContext {
  const request = objectOf(body) ?? {}
  const metadata = objectOf(request.metadata)
  const headerPurpose = knownPurpose(options.querySource)
  const metadataPurpose = [request.query_source, request.querySource, metadata?.query_source, metadata?.querySource]
    .map(knownPurpose).find((purpose) => purpose !== undefined)
  const prompt = headerPurpose || metadataPurpose ? undefined : promptPurpose(request)
  const purpose = headerPurpose ?? metadataPurpose ?? prompt ?? 'main'
  const source = headerPurpose ? 'header' : metadataPurpose ? 'metadata' : prompt ? 'prompt' : 'default'
  const session = typeof options.sessionKey === 'string' ? options.sessionKey : ''
  const subagent = typeof options.subagentKey === 'string' ? options.subagentKey.trim() : ''
  const isolated = purpose !== 'main'
  let sessionKey = session
  if (isolated || subagent) {
    const hash = createHash('sha256').update(JSON.stringify([session, subagent])).digest('hex')
    sessionKey = isolated ? `background:${purpose}:${hash}` : `subagent:${hash}`
  }
  return { purpose, source, isolated, sessionKey }
}
