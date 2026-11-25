// Turning normalized turn items into the wire response (OpenAI shapes).
//
// Two renderers with the same input: a chat.completion object, or an SSE
// stream of chat.completion.chunk frames ending in [DONE]. Kept separate from
// the handler so the request pipeline (validate → prepare → pump) does not
// also own response formatting.
import { OutpostError } from '../outpost.ts'
import { QuickWsError } from '../quickws.ts'
import { addUsage } from '../turn/consume.ts'
import type { TurnItem } from '../turn/consume.ts'

export function errorResponse(status: number, message: string, type = 'api_error') {
  return new Response(JSON.stringify({ error: { message, type, code: status } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** OpenAI error.type for a failure's kind/status. */
export function errorType(err: any) {
  if (err?.kind === 'auth') return 'authentication_error'
  if (err?.status === 429 || err?.kind === 'quota') return 'rate_limit_error'
  if (err?.kind === 'too_large') return 'invalid_request_error'
  return 'api_error'
}

/** HTTP status for a failure: plugin/transport kinds first, then the error's own status. */
export function httpStatus(err: any) {
  if (err instanceof OutpostError || err instanceof QuickWsError) {
    if (err.kind === 'auth') return 401
    if (err.kind === 'abort') return 499
    if (err.kind === 'quota') return 429
    if (err.kind === 'too_large') return 400
    if (err.kind === 'spawn' || err.kind === 'timeout') return 503
  }
  return err?.status && err.status >= 400 && err.status < 600 ? err.status : 502
}

export function makeId(threadId: string | undefined) {
  return `chatcmpl-quick-${threadId?.slice(0, 8) ?? 'x'}-${Date.now().toString(36)}`
}

const EMPTY_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

export interface RespondOptions {
  id: string
  created: number
  model: string
  stream: boolean
  /** stream_options.include_usage — one final usage-only chunk. */
  includeUsage: boolean
  /** A failed turn: the caller records quota bookkeeping, then we answer. */
  onError: (e: any) => void
  /** The client went away while streaming: abandon both generators. */
  onCancel: () => void
}

/** Render the turn's items as chat.completion (or an SSE stream). */
export async function respondWithItems(items: AsyncIterable<TurnItem>, opts: RespondOptions): Promise<Response> {
  const { id, created, model } = opts
  if (!opts.stream) {
    let text = ''
    let reasoning = ''
    const calls: any[] = []
    let usage
    try {
      for await (const o of items) {
        if (o.type === 'text') text += o.text
        // Notes are part of the assistant message the client stores (the
        // stream renders them the same way), so the non-stream shape must
        // carry them too — otherwise the reply we hash and the reply the
        // client holds differ, and the next turn starts a new thread.
        else if (o.type === 'note') text += `\n\n> ${o.text}`
        else if (o.type === 'reasoning') reasoning += o.text
        else if (o.type === 'tool_call') calls.push({ id: o.id, type: 'function', function: { name: o.name, arguments: o.arguments } })
        else if (o.type === 'usage') usage = addUsage(usage, o.usage)
      }
    } catch (e) {
      opts.onError(e)
      return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
    }
    const message: any = { role: 'assistant', content: text }
    if (reasoning) message.reasoning_content = reasoning
    if (calls.length) message.tool_calls = calls
    return new Response(
      JSON.stringify({
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        usage: usage ?? EMPTY_USAGE,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
      const chunk = (delta: any, finish: string | null = null) => send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })
      let sentRole = false
      const role = () => {
        if (!sentRole) {
          sentRole = true
          chunk({ role: 'assistant', content: '' })
        }
      }
      let toolIndex = 0
      let usage
      try {
        for await (const o of items) {
          if (o.type === 'text') {
            role()
            chunk({ content: o.text })
          } else if (o.type === 'reasoning') {
            role()
            chunk({ reasoning_content: o.text })
          } else if (o.type === 'tool_call') {
            role()
            chunk({ tool_calls: [{ index: toolIndex++, id: o.id, type: 'function', function: { name: o.name, arguments: o.arguments } }] })
          } else if (o.type === 'usage') usage = addUsage(usage, o.usage)
          else if (o.type === 'note') {
            role()
            chunk({ content: `\n\n> ${o.text}` })
          }
        }
        role()
        chunk({}, toolIndex > 0 ? 'tool_calls' : 'stop')
        if (opts.includeUsage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage ?? EMPTY_USAGE })
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
      } catch (e) {
        // A mid-stream failure cannot become an HTTP status: the client sees
        // an OpenAI-shaped error frame instead (quota bookkeeping already ran
        // before the stream started).
        send({ error: { message: e?.message ?? String(e), type: errorType(e), code: httpStatus(e) } })
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
      } finally {
        controller.close()
      }
    },
    cancel() { opts.onCancel() },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}
