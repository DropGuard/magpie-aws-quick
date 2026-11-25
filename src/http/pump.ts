// Answering with headers before the turn produces output.
//
// Magpie marks an account on 401 and fails over on 429/5xx, so auth and quota
// failures must surface as real HTTP statuses — not a 200 stream that dies
// immediately. This pump therefore pulls the turn's first events before the
// response is built: meta is captured, leading notes are kept (they ride the
// stream), and the first real output ends the wait. For streaming, headerWaitMs
// caps the wait — agentic turns can sit silent while Quick runs its own tools,
// and the gateway only waits so long for response headers.
//
// pull() keeps at most one it.next() in flight: after the deadline the same
// pending promise is what items awaits, never a second next() call.
import type { TurnItem } from '../turn/consume.ts'

/** Sentinel for "headerWaitMs elapsed while waiting for first output". */
export const HDR_WAIT = Symbol('header-wait')

export interface Primed {
  /** Items pulled while waiting (leading notes first): replay before the rest. */
  pre: TurnItem[]
  /** The turn's meta event (carries threadId), when one arrived. */
  meta?: any
  /** The turn finished before producing any output. */
  done: boolean
  /** The remaining items, with at most one next() in flight. */
  items: AsyncGenerator<TurnItem>
}

/** Pull up to the first real output, then hand back the rest as one stream. */
export async function primeItems(it: AsyncGenerator<any>, { stream, headerWaitMs }: { stream: boolean; headerWaitMs: number }): Promise<Primed> {
  const giveUpAt = stream && headerWaitMs > 0 ? Date.now() + headerWaitMs : 0
  const pre: TurnItem[] = []
  let done = false
  let meta
  let pendingNext: Promise<IteratorResult<any>> | null = null
  const pull = () => {
    if (!pendingNext) {
      const p = it.next()
      pendingNext = p
      const clear = () => { if (pendingNext === p) pendingNext = null }
      p.then(clear, clear)
    }
    return pendingNext
  }
  for (;;) {
    let r: any
    if (giveUpAt) {
      const remaining = giveUpAt - Date.now()
      if (remaining <= 0) break
      let timer: any
      const timedOut = new Promise((res) => { timer = setTimeout(() => res(HDR_WAIT), remaining) })
      r = await Promise.race([pull(), timedOut])
      clearTimeout(timer)
      if (r === HDR_WAIT) break
    } else {
      r = await pull()
    }
    if (r.done) { done = true; break }
    if (r.value.type === 'meta') { meta = r.value; continue }
    // Notes (context attached, transcript cut, a tool call dropped) are
    // yielded before the first output while this loop waits for headers —
    // keep them so they ride the stream instead of being swallowed here.
    if (r.value.type === 'note') { pre.push(r.value); continue }
    pre.push(r.value)
    break
  }
  const items = (async function* () {
    yield* pre
    if (done) return
    for (;;) {
      const r = await pull()
      if (r.done) return
      yield r.value
    }
  })()
  return { pre, meta, done, items }
}
