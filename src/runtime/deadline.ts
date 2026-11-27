export const DEFAULT_CALL_TIMEOUT_MS = 600_000

type AbortableSignal = AbortSignal & { reason?: unknown }

function abortReason(signal?: AbortableSignal): unknown {
  if (!signal?.aborted) return undefined
  return signal.reason ?? new Error('aborted')
}

/** Race a value against a signal without leaving a rejection handler behind. */
export function abortable<T>(value: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  const work = Promise.resolve(value)
  if (!signal) return work

  if (signal.aborted) {
    // The caller is already done, but still consume a later rejection from work.
    work.then(() => {}, () => {})
    return Promise.reject(abortReason(signal as AbortableSignal))
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortReason(signal as AbortableSignal))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    // Recheck in case a non-native AbortSignal implementation changed state
    // while the listener was being installed.
    if (signal.aborted) onAbort()

    work.then(
      (result) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      },
      (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

export interface CallScope {
  signal: AbortSignal
  deadlineAt: number | null
  timeoutMs: number
  remainingMs(): number
  check(): void
  wait<T>(value: PromiseLike<T> | T): Promise<T>
  abort(reason?: unknown): void
  normalize(error: unknown): any
  dispose(): void
}

function makeAbortError(message: string, kind: 'abort' | 'timeout', status: number): Error & { kind: string; status: number } {
  const error = new Error(message) as Error & { kind: string; status: number }
  error.kind = kind
  error.status = status
  return error
}

/** Create a request-local cancellation scope with a fixed, non-resetting deadline. */
export function createCallScope({
  signal: externalSignal,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
}: { signal?: AbortSignal; timeoutMs?: number } = {}): CallScope {
  const controller = new AbortController()
  const startedAt = Date.now()
  const deadlineAt = timeoutMs === 0
    ? null
    : Number.isFinite(timeoutMs)
      ? startedAt + Math.max(0, timeoutMs)
      : null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const unlinkExternal = () => externalSignal?.removeEventListener('abort', onExternalAbort)
  const detach = () => {
    clearTimer()
    unlinkExternal()
  }
  const abortWith = (reason: unknown) => {
    if (controller.signal.aborted) return
    controller.abort(reason)
    detach()
  }
  const timeoutError = () => makeAbortError(`Request timed out: requestTimeoutMs=${timeoutMs}ms`, 'timeout', 503)
  const onExternalAbort = () => {
    abortWith(makeAbortError('Request cancelled', 'abort', 499))
  }

  const scheduleDeadline = () => {
    if (deadlineAt === null || controller.signal.aborted || disposed) return
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) {
      abortWith(timeoutError())
      return
    }
    // Keep deadlines longer than the platform timer limit fixed rather than
    // allowing setTimeout's overflow behavior to fire early.
    timer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647))
  }

  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  if (!controller.signal.aborted) scheduleDeadline()

  return {
    signal: controller.signal,
    deadlineAt,
    timeoutMs,
    remainingMs() {
      return deadlineAt === null ? Infinity : Math.max(0, deadlineAt - Date.now())
    },
    check() {
      if (!controller.signal.aborted && deadlineAt !== null && Date.now() >= deadlineAt) {
        abortWith(timeoutError())
      }
      if (controller.signal.aborted) throw controller.signal.reason
    },
    wait<T>(value: PromiseLike<T> | T) {
      const work = Promise.resolve(value)
      try {
        this.check()
      } catch (error) {
        // check() can fail synchronously (e.g. a pre-aborted scope); consume
        // the supplied work's rejection even though the caller won't await it.
        work.then(() => {}, () => {})
        return Promise.reject(error)
      }
      return abortable(work, controller.signal).then((result) => {
        // A resolved wait must not advance after a blocked event loop delayed
        // the deadline timer itself.
        this.check()
        return result
      })
    },
    abort(reason?: unknown) {
      if (arguments.length > 0 && reason instanceof Error) {
        abortWith(reason)
      } else {
        const message = reason === undefined ? 'Request cancelled' : String(reason)
        abortWith(makeAbortError(message, 'abort', 499))
      }
    },
    normalize(error: unknown) {
      return controller.signal.aborted ? controller.signal.reason : error
    },
    dispose() {
      if (disposed) return
      disposed = true
      detach()
    },
  }
}
