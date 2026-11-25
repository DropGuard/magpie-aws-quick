// What to do when a turn fails, decided in one place.
//
// Three recovery paths used to be interleaved inside the turn loop, so their
// interactions (guardrail x reused-thread x produced-output) were only visible
// by reading the whole thing. The policy is pure: give it the failure and the
// turn's state, get back exactly one action.

export type TurnFailure = { kind?: string; status?: number }

export type RetryState = {
  /** Guardrail retries already spent this turn. */
  guardTries: number
  /** Budget for them (guardrailRetries, default 1). */
  guardMax: number
  /** The turn was continuing a cached thread (there is something to re-send). */
  reused: boolean
  /** Anything already streamed to the client (text, reasoning or a call). */
  produced: boolean
}

export type RetryAction =
  /** Give up: surface the error (already labelled for guardrails). */
  | { type: 'stop' }
  /** Same thread, one nudge: a server-side content check stopped it with no output. */
  | { type: 'guardrail-retry' }
  /** New thread, full transcript: the cached thread is gone server-side. */
  | { type: 'fresh-thread-retry' }

export function nextRetry(state: RetryState, err: TurnFailure | undefined): RetryAction {
  const kind = err?.kind ?? ''
  // A guardrail stop leaves no answer at all; retrying it here is what the user
  // would otherwise do by hand with "continue". Never retry once output exists:
  // it could not be retracted.
  if (kind === 'guardrail' && !state.produced && state.guardTries < state.guardMax) {
    return { type: 'guardrail-retry' }
  }
  // Guardrail budget spent: do not fall through to a fresh thread carrying the
  // same content — it would be blocked again for the price of a full resend.
  // Surface the labelled block instead.
  if (kind === 'guardrail') return { type: 'stop' }
  // Never re-send on auth trouble or a timeout (the watchdog already ran), and
  // only when a cached thread exists to re-send FROM. An empty answer already
  // spent its own bounded retries on the same thread; resending the whole
  // transcript would just buy the same silence again.
  if (kind === 'auth' || kind === 'timeout' || kind === 'empty') return { type: 'stop' }
  if (state.produced || !state.reused) return { type: 'stop' }
  return { type: 'fresh-thread-retry' }
}
