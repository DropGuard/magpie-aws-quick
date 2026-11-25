// Errors in this codebase carry extra fields set by their factories
// (fail() in attach.ts, QuickWsError/OutpostError, the outpost spawner).
// Declaring them once keeps every catch site typed without casts.
export {}
declare global {
  interface Error {
    kind?: string
    reason?: string
    status?: number
  }
}
