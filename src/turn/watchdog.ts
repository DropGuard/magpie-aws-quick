// One turn's idle watchdog and abort translation.
//
// Every Quick event counts as progress except transport noise (keepalive/ping/
// pong, ok-status pings, UI bookkeeping). Silence past idleMs aborts an
// internal controller linked to the request signal, so socket.turn wakes even
// when Quick sends nothing at all. Whether the abort came from the watchdog
// changes the error the client sees, and that distinction used to be a pair of
// booleans threaded through the turn generator.
import { QuickWsError } from '../quickws.ts'

export interface Watchdog {
  /** Signal for socket.turn: request abort, watchdog timeout, or salvage stop. */
  signal: AbortSignal
  /** Any progress event: restart the idle timer. */
  bump: () => void
  /** End the current stream without treating it as a timeout (tool salvage). */
  abort: () => void
  /**
   * Translate an abort into the error the caller should see; null for ordinary
   * turn errors (which may still reach the retry policy).
   */
  termination: (e: any, tid: string, stop: (tid: string) => void) => any
  /** Clear the timer and unlink from the request signal. */
  dispose: () => void
}

export function createWatchdog({ idleMs, signal }: { idleMs: number; signal?: AbortSignal }): Watchdog {
  const ctl = new AbortController()
  const linkRequestAbort = () => ctl.abort()
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', linkRequestAbort, { once: true })
  }
  let fired = false
  let timer: any = null
  const bump = () => {
    if (!idleMs) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { fired = true; ctl.abort() }, idleMs)
    timer.unref?.()
  }
  bump()
  return {
    signal: ctl.signal,
    bump,
    abort: () => ctl.abort(),
    termination(e, tid, stop) {
      if (fired) {
        stop(tid)
        return new QuickWsError(`Quick 已 ${idleMs / 1000}s 没有进展，已中止本轮 (idleTimeoutMs)`, { kind: 'timeout' })
      }
      if (signal?.aborted || e?.kind === 'abort') {
        stop(tid)
        return e
      }
      return null
    },
    dispose() {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', linkRequestAbort)
    },
  }
}
