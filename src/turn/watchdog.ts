// One turn's idle watchdog and abort translation.
//
// This timer is the LAST resort for model silence — Quick accepted the turn and
// then sent nothing. It is not a bound for our own I/O: uploads, auth calls and
// probes carry their own explicit timeouts and fallbacks (see attach.ts and
// turn/attachments.ts), so a dead endpoint fails in seconds, not here.
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
  let fired = false
  let salvaged = false
  let timer: any = null
  const clearTimer = () => {
    if (timer !== null) { clearTimeout(timer); timer = null }
  }
  const linkRequestAbort = () => {
    clearTimer()
    ctl.abort(signal?.reason)
  }
  if (signal) {
    if (signal.aborted) linkRequestAbort()
    else signal.addEventListener('abort', linkRequestAbort, { once: true })
  }
  const bump = () => {
    if (!idleMs || ctl.signal.aborted) return
    clearTimer()
    timer = setTimeout(() => { timer = null; fired = true; ctl.abort() }, idleMs)
    timer.unref?.()
  }
  bump()
  return {
    signal: ctl.signal,
    bump,
    abort: () => {
      if (ctl.signal.aborted) return
      salvaged = true
      clearTimer()
      ctl.abort(new QuickWsError('turn stopped for salvage', { kind: 'salvage' }))
    },
    termination(e, tid, stop) {
      if (signal?.aborted && (signal as any).reason?.kind === 'timeout') {
        stop(tid)
        return (signal as any).reason
      }
      if (fired) {
        stop(tid)
        return new QuickWsError(`Quick 已 ${idleMs / 1000}s 没有进展，已中止本轮 (idleTimeoutMs)`, { kind: 'timeout' })
      }
      if (salvaged) return null
      if (signal?.aborted || e?.kind === 'abort') {
        stop(tid)
        return e
      }
      return null
    },
    dispose() {
      clearTimer()
      signal?.removeEventListener?.('abort', linkRequestAbort)
    },
  }
}
