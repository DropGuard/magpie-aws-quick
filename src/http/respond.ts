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

function normalizeFailure(opts: RespondOptions, error: any) {
  try { return opts.normalizeError?.(error) ?? error } catch { return error }
}

export interface RespondOptions {
  id: string
  created: number
  model: string
  stream: boolean
  /** stream_options.include_usage — one final usage-only chunk. */
  includeUsage: boolean
  /** A failed turn: the caller records quota bookkeeping, then we answer. */
  onError: (e: any) => void
  /** The client went away while streaming: abort and clean up both generators. */
  onCancel: () => void | Promise<void>
  /** Normalize call-scope cancellation/deadline errors before mapping them to HTTP/SSE. */
  normalizeError?: (e: any) => any
  /** The turn is over (success, error or cancel): release the conversation lane. */
  onSettled?: () => void
}

/** Render the turn's items as chat.completion (or an SSE stream). */
export async function respondWithItems(items: AsyncIterable<TurnItem>, opts: RespondOptions): Promise<Response> {
  const { id, created, model } = opts
  let settled = false
  const settleOnce = () => {
    if (settled) return
    settled = true
    opts.onSettled?.()
  }
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
      const error = normalizeFailure(opts, e)
      try { opts.onError(error) } catch {}
      return errorResponse(httpStatus(error), error?.message ?? String(error), errorType(error))
    } finally {
      settleOnce()
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
  let cancelled = false
  let cancelCleanup: Promise<void> | null = null
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => {
        if (!cancelled) controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
      }
      const sendDone = () => {
        if (!cancelled) controller.enqueue(enc.encode('data: [DONE]\n\n'))
      }
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
        sendDone()
      } catch (e) {
        const error = normalizeFailure(opts, e)
        // A mid-stream failure cannot become an HTTP status; report it to
        // bookkeeping and, unless the client cancelled, emit an error frame.
        try { opts.onError(error) } catch {}
        if (!cancelled) {
          send({ error: { message: error?.message ?? String(error), type: errorType(error), code: httpStatus(error) } })
          sendDone()
        }
      } finally {
        if (cancelCleanup) {
          try { await cancelCleanup } catch {}
        }
        if (!cancelled) controller.close()
        settleOnce()
      }
    },
    cancel() {
      if (cancelled) return cancelCleanup ?? undefined
      cancelled = true
      try { cancelCleanup = Promise.resolve(opts.onCancel()) }
      catch (error) { cancelCleanup = Promise.reject(error) }
      return cancelCleanup
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}
