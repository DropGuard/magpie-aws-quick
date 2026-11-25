// One turn, planned before anything streams.
//
// The turn generator used to compute all of this inline, and the fresh-thread
// retry carried its own copy of the payload half. Now the halves have names:
//
//   buildTurnContext()  what is stable across attempts — conversation, thread
//                       choice (reuse vs fresh), budgets, upload helpers, the
//                       stats bag every cut reports into
//   composeAttempt()    one user_message for one thread: preamble + history +
//                       image/context attachments + instructions, and the one
//                       note the client must see with it
//
// handler.ts's runTurn only streams an AttemptPlan, retries it, and writes the
// session entry back. Budget arithmetic lives in protocol/frame.ts; this module
// decides WHAT goes into the frame, never how many bytes it may take.
import crypto from 'node:crypto'
import { QuickWsError } from '../quickws.ts'
import { normalizeTools, buildToolPreamble } from '../tools.ts'
import {
  renderTranscript, renderDelta, renderToolCalls, textOf, byteLen, capText, capMiddle, setInstructions, canonRole,
} from '../translate.ts'
import type { RenderStats } from '../translate.ts'
import { resolveReuse } from './reuse.ts'
import type { Reuse } from './reuse.ts'
import { pickTurnImages, createAttachmentFlow, CONTEXT_ATTACHED_NOTE, TOO_LONG_ERR, TOOL_UPLOAD_MIN } from './attachments.ts'
import { PLAIN_TEXT_NOTE, TOOLS_STILL_APPLY, INVALID_CALL_TOOL, cutNote } from './prompts.ts'
import { frameRoom, pickPreamble } from '../protocol/frame.ts'



/**
 * Everything that is the same for every attempt of one turn. Built once, then
 * handed to composeAttempt() per thread.
 */
export interface TurnContext {
  convo: any[]
  tools: any[]
  mode: string
  systemText: string
  base: any
  customPrompt: string
  /** Tool spec for the FIRST attempt (reuse: reminder + added tools; fresh: full). */
  preamble: string
  textCap: number
  textBudget: number
  turnBudget: number
  frameCap: number
  scope: string
  hashes: string[]
  sessionKey: string
  reuse?: Reuse
  /** Entries removed from the store for reuse — returned on failure. */
  taken: [string, any][]
  stats: RenderStats
  mark: (why: string) => void
  mergeStats: (from: RenderStats | null | undefined) => void
  fitPreamble: (list?: any[], need?: number) => string
  uploadAll: (tid: string) => Promise<{ entries: any[]; failed: number }>
  attachContext: (tid: string) => Promise<any>
  /** Pointer text for a transcript replaced by `entry`, with a recent tail. */
  attachPointer: (entry: any, headroom: number) => string
  /** Upload one oversized tool result (null when it could not be delivered). */
  uploadToolResult: (tid: string, name: string, text: string) => Promise<any | null>
  imageNoteFor: (failed: number) => string
  currentTurnNeed: number
  canonClientTool: (name: any) => string | null
  showQuickTools: boolean
  images: any
  toolNames: string[]
  options: any
  signal?: AbortSignal
}

/** One user_message for one thread, plus the note the client must see. */
export interface AttemptPlan {
  threadId: string
  reused: boolean
  payload: any
  /** Non-empty when the client should be told what was trimmed/attached. */
  note: string
  toolNames: string[]
}

export interface TurnInput {
  body: any
  outpost: any
  sessions: any
  options: any
  signal?: AbortSignal
  /** Caller's system prompt, already joined by handleChatCompletions. */
  systemText: string
  /** Base user_message fields (message_id, agent_mode, tz/locale, effort). */
  base: any
}

/** Conversation, thread choice, instruction channels and budgets for a turn. */
export function buildTurnContext({ body, outpost, sessions, options, signal, systemText, base }: TurnInput): TurnContext {
  const messages = body.messages
  const convo = messages.filter((m) => m.role !== 'system' && m.role !== 'developer')
  const tcNone = body.tool_choice === 'none' || (typeof body.tool_choice === 'object' && body.tool_choice?.type === 'none')
  const tools = tcNone ? [] : normalizeTools(body.tools)
  const mode = base?.agent_mode || 'smart'
  // Quick's model sometimes calls a client tool through its own native
  // function calling (tool_start → tool_arguments → tool_result) instead of
  // our <tool_call> text convention; Quick has no such tool, so it errors
  // "Unknown tool" and the model rewrites everything as text — one observed
  // request took 285 s that way. consume() salvages those: a tool_arguments
  // event naming a client tool becomes a regular tool_call, then the turn is
  // stopped before the error+rewrite step. Names match exactly first, then
  // case-insensitively; the client's spelling is what gets emitted.
  const clientToolExact = new Set(tools.map((t) => t.name))
  const clientToolLower = new Map(tools.map((t) => [t.name.toLowerCase(), t.name]))
  const canonClientTool = (name: any): string | null => {
    if (!clientToolExact.size || typeof name !== 'string' || !name) return null
    if (clientToolExact.has(name)) return name
    return clientToolLower.get(name.toLowerCase()) ?? null
  }
  const stats: RenderStats = {}
  // Every truncation records its reason ('preamble'/'frame' here, the rest in
  // translate.ts) so the note can say what actually happened.
  const mark = (why: string) => {
    stats.truncated = true
    stats.cut ||= {}
    stats.cut[why] = (stats.cut[why] || 0) + 1
  }
  // A render into a side stats object (fresh transcript, stale-thread retry)
  // feeds back here so the turn's overall picture is what the note reports.
  const mergeStats = (from: RenderStats | null | undefined) => {
    if (!from) return
    if (from.truncated) stats.truncated = true
    if (from.dropped) stats.dropped = (stats.dropped || 0) + from.dropped
    for (const [why, n] of Object.entries((from.cut || {}) as Record<string, number>)) {
      stats.cut ||= {}
      stats.cut[why] = (stats.cut[why] || 0) + n
    }
  }
  const sessionKey = typeof options?.sessionKey === 'string' ? options.sessionKey.slice(0, 128) : ''
  // Quick's own tool_start/tool_progress/tool_result events are agent-internal;
  // showQuickTools surfaces each tool_start as a [Quick: name] reasoning line.
  const showQuickTools = options?.showQuickTools !== false
  // custom_prompt is a real per-turn instruction channel (verified live). Use
  // it to tell the model this session is app-driven: with client tools, steer
  // local-environment work to the <tool_call> protocol; on direct backends
  // (OAuth / Credential Manager — no outpost, hence no connected device) also
  // say built-in device tools cannot run, so the model doesn't burn agentic
  // turns on guaranteed failures. The local-outpost path may genuinely have a
  // device attached, so the claim stays off there.
  const directBackend = !!outpost?.direct
  const baseCustomPrompt = tools.length
    ? directBackend
      ? 'Calling context: this chat is driven by an external application. The client tools listed in the message are executed by that application on the user\'s machine; this session has no connected device, so built-in device tools (local files, apps) cannot run here. For questions about the user\'s project, files or code, call the client tools to read current contents — earlier tool results may be partial, and a fresh read beats guessing.'
      : 'Calling context: this chat is driven by an external application. The client tools listed in the message are executed by that application on the user\'s machine — for questions about the user\'s project, files or code, call them to read current contents; earlier tool results may be partial, and a fresh read beats guessing.'
    : directBackend
      ? 'Calling context: this chat is driven by an external application and has no connected device. Built-in tools that need the user\'s device (local files, apps) cannot run in this session — say so plainly rather than attempting them.'
      : ''
  const customPrompt = [baseCustomPrompt, tools.length ? TOOLS_STILL_APPLY : '', PLAIN_TEXT_NOTE].filter(Boolean).join(' ')
  // protocol/frame.ts owns every byte of this arithmetic.
  const textCap = frameRoom({ systemText, customPrompt })

  const identity = options?.identity || 'local'
  const { scope, hashes, reuse, taken } = resolveReuse({ sessions, identity, mode, systemText, convo, sessionKey })
  // The tool spec is the disposable part of the frame: the caller's message
  // (with AGENTS.md and the memory index inside its <system-reminder>) must
  // arrive whole, so the spec compresses first — descriptions before schemas,
  // and only as far as the room requires. protocol/frame.ts owns the ladder.
  const fitPreamble = (list: any[] = tools, need = 0) => {
    const picked = pickPreamble({ tools: list, toolChoice: body.tool_choice, room: textCap, need })
    if (picked.concession) {
      mark('preamble')
      stats.specTier = picked.tier
    }
    return picked.preamble
  }
  // Bytes the current message needs beside the preamble (its injected
  // instructions included), capped at what a turn may take.
  const currentTurnNeed = Math.min(byteLen(textOf(convo.at(-1)?.content ?? '')), 20 * 1024) + 256
  // What this thread will have seen once this turn lands.
  const known = reuse?.entry?.toolNames ? new Set(reuse.entry.toolNames) : null
  const added = reuse ? tools.filter((t) => !known?.has(t.name)) : []
  const preamble = !tools.length ? ''
    : !reuse ? fitPreamble(tools, currentTurnNeed)
      : [added.length ? fitPreamble(added) : '', buildToolPreamble(tools, body.tool_choice, { reminder: true })].filter(Boolean).join('\n\n')
  const toolNames = [...new Set([...(reuse ? known ?? [] : []), ...tools.map((t) => t.name)])]
  const textBudget = Math.max(4 * 1024, textCap - byteLen(preamble))

  // Images ride user_message.attachments: small ones inline as base64 inside
  // the frame; larger ones go through Quick's cloud attachment upload
  // (attachments.ts) on every backend. Only this turn's images are sent;
  // inline bytes shrink the text budget, uploaded ones don't.
  const images = pickTurnImages({ convo, reuse, textBudget })
  const turnBudget = textBudget - images.bytes
  const frameCap = textCap - images.bytes
  const { imageNoteFor, uploadAll, attachContext, attachPointer, uploadToolResult } = createAttachmentFlow({ outpost, options, signal, convo, images })

  return {
    convo, tools, mode,
    systemText, base, customPrompt, preamble, textCap, textBudget, turnBudget, frameCap,
    scope, hashes, sessionKey, reuse, taken, stats, mark, mergeStats, fitPreamble,
    uploadAll, attachContext, attachPointer, uploadToolResult, imageNoteFor, currentTurnNeed,
    canonClientTool, showQuickTools, images, toolNames, options, signal,
  }
}

/**
 * Replace oversized tool results with a pointer + a small head/tail preview,
 * uploading the full text. Used when the frame had to cut tool output: the
 * model keeps the useful ends and can read the middle from the file.
 * Returns the rewritten messages, or null when nothing could be uploaded.
 */
async function swapBigToolResults(ctx: TurnContext, threadId: string, messages: any[], attachments: any[], opts: { startAt?: number } = {}): Promise<any[] | null> {
  const start = opts.startAt ?? 0
  const big = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m, i }) => i >= start && canonRole(m.role) === 'tool' && byteLen(textOf(m.content)) > TOOL_UPLOAD_MIN)
    .sort((a, b) => byteLen(textOf(b.m.content)) - byteLen(textOf(a.m.content)))
    .slice(0, 2)
  if (!big.length) return null
  const swapped = [...messages]
  const uploaded: any[] = []
  for (const { m, i } of big) {
    const body = textOf(m.content)
    const name = `tool_${crypto.randomUUID().slice(0, 8)}.txt`
    const entry = await ctx.uploadToolResult(threadId, name, body)
    if (!entry) continue
    uploaded.push(entry)
    const id = m.tool_call_id || m.name || 'tool'
    const preview = capMiddle(body, 4096)
    swapped[i] = { ...m, content: `[tool_result ${id} — ${byteLen(body)} bytes; the full output is in the attached file ${entry.name}. Read that file when the middle of the output matters.]\n${preview}` }
  }
  if (!uploaded.length) return null
  attachments.push(...uploaded)
  return swapped
}

/**
 * Assemble one user_message for threadId. `reuse` appends the delta to a
 * cached thread; otherwise the whole conversation is rendered (and attached
 * when it does not fit). `retry` marks the fresh-thread retry, whose trimming
 * policy differs slightly (it caps the whole text instead of shedding the
 * preamble first — the caller already saw a failure, so the full transcript
 * wins over the tool spec).
 */
export async function composeAttempt(ctx: TurnContext, { threadId, reuse, retry = false }: { threadId: string; reuse?: Reuse | null; retry?: boolean }): Promise<AttemptPlan> {
  const uploaded = await ctx.uploadAll(threadId)
  const imageNote = ctx.imageNoteFor(uploaded.failed)
  const attachments = ctx.images.attachments.concat(uploaded.entries)
  let contextNote = ''
  let text: string
  let reused = false
  let local: RenderStats | null = null
  if (reuse) {
    // A turn that ended in native-tool salvage was stopped server-side: the
    // reused thread's history holds an empty assistant message + "You stopped
    // the response." — NOT the call the client is now answering. Re-state it
    // (same rendering transcript history uses for tool_calls) ahead of the
    // delta, once: the entry written after this turn carries no flag.
    const salvagePrefix = reuse.entry.salvageCalls?.length
      ? `[Your previous turn was interrupted after you called these tools; the client executed them. Ignore any "Unknown tool" error recorded for them: they run on the client, so keep calling client tools with <tool_call> blocks.]\nassistant: ${renderToolCalls(reuse.entry.salvageCalls)}\n\n`
      : ''
    const dc = reuse.entry.droppedCall
    const droppedPrefix = dc
      ? `[Note: your previous <tool_call>${dc.name ? ` for ${dc.name}` : ''} ${dc.reason === 'unterminated'
        ? 'was cut off before </tool_call>, so the client never ran it. Call it again; if the content is long, split it into several smaller calls (e.g. write the file in parts).'
        : 'was not valid JSON, so the client never ran it. Call it again with valid JSON (escape newlines and quotes inside strings).'
      } Any error for ${INVALID_CALL_TOOL} below is just the placeholder for that failed call.]\n\n`
      : ''
    const prefix = salvagePrefix + droppedPrefix
    const budget = ctx.turnBudget - byteLen(prefix)
    let local: RenderStats = {}
    let rendered = renderDelta(reuse.delta, { maxBytes: budget, stats: local })
    if (local.cut?.tool) {
      const swapped = await swapBigToolResults(ctx, threadId, reuse.delta, attachments)
      if (swapped) {
        local = {}
        rendered = renderDelta(swapped, { maxBytes: budget, stats: local })
      }
    }
    ctx.mergeStats(local)
    text = prefix + rendered + imageNote
    reused = true
  } else {
    local = {}
    let rendered = renderTranscript(ctx.convo, '', { maxBytes: ctx.turnBudget, stats: local })
    // A fresh frame can still carry this turn's tool results (after a re-thread
    // the client resends the conversation). Cutting one is the same loss as on
    // a reused turn, so the same upload applies — but only to results after the
    // last assistant message: earlier ones are deliberately stale (2 KB cap).
    if (!local.dropped && local.cut?.tool) {
      let lastAsst = -1
      for (let i = ctx.convo.length - 1; i >= 0; i--) if (canonRole(ctx.convo[i]?.role) === 'assistant') { lastAsst = i; break }
      const swapped = await swapBigToolResults(ctx, threadId, ctx.convo, attachments, { startAt: lastAsst + 1 })
      if (swapped) {
        local = {}
        rendered = renderTranscript(swapped, '', { maxBytes: ctx.turnBudget, stats: local })
      }
    }
    ctx.mergeStats(local)
    text = rendered + imageNote
    // History that had to be dropped from the frame is not thrown away: it
    // rides an attachment and the message only points at it.
    if (local.dropped) {
      let entry = null
      try {
        entry = await ctx.attachContext(threadId)
      } catch (e: any) {
        if (ctx.signal?.aborted || e?.name === 'AbortError') throw e
        ctx.options?.log?.(`[aws-quick] context attachment failed: ${String(e?.message ?? e).slice(0, 200)}`)
      }
      if (!entry) throw new QuickWsError(TOO_LONG_ERR, { kind: 'too_large', status: 400 })
      attachments.push(entry)
      text = ctx.attachPointer(entry, ctx.turnBudget)
      ctx.stats.truncated = true
      contextNote = CONTEXT_ATTACHED_NOTE
    }
  }
  // The tool convention rides inside the user_message text (there is no
  // client-tool channel); on reused threads only the short reminder rides,
  // since every byte of text stays in the thread and counts toward context.
  // A reused thread already holds the spec of every tool described in it
  // (entry.toolNames), and whatever rides in `text` stays in Quick's history —
  // so later turns get a short reminder, plus the full spec of just the tools
  // added since. Fresh threads, including the stale-thread retry, get the
  // full spec. An entry reloaded from disk without toolNames gets everything
  // once.
  const preamble = retry
    ? (ctx.tools.length ? ctx.fitPreamble(ctx.tools, ctx.currentTurnNeed) : '')
    : ctx.preamble
  let upstreamText = preamble ? `${preamble}\n\n${text}` : text
  if (byteLen(upstreamText) > ctx.frameCap) {
    if (retry) {
      upstreamText = capText(upstreamText, ctx.frameCap)
    } else {
      // Last resort before the tail-cutting hard cap: shed the preamble so the
      // user's message survives intact (tool calling degrades, the answer doesn't).
      upstreamText = byteLen(text) <= ctx.frameCap ? text : capText(text, ctx.frameCap)
    }
    ctx.mark('frame')
  }
  if (!upstreamText.trim()) upstreamText = '(empty)'

  const payload: any = { ...ctx.base, text: upstreamText }
  if (ctx.tools.length) payload.web_search_enabled = false
  if (attachments.length) payload.attachments = attachments
  const clippedSystem = setInstructions(payload, ctx.systemText, ctx.customPrompt, threadId)
  // The runner yields this note before the turn loop, so it must also be part
  // of the client-visible text: the reply we hash has to match what the client
  // stores, or the next turn starts a new thread.
  const note = contextNote || (retry
    ? (local?.dropped ? '' : cutNote(local, false))
    : cutNote(ctx.stats, clippedSystem))
  return {
    threadId, reused, payload, note,
    toolNames: reuse ? ctx.toolNames : ctx.tools.map((t) => t.name),
  }
}
