/**
 * The one place a caught value is narrowed.
 *
 * Every errno decision in this tree is drawn from `error.code`, and every
 * diagnostic string from `error.message` / `error.stack`. `catch` hands over
 * `unknown`, and `stat`/`readFile`/`spawnDirenv` are injection points that may
 * reject with anything at all, so the narrowing lives here instead of being
 * re-invented (or asserted away) at each call site.
 */

/** A plain-object view of an unknown value: the only shape whose fields may be read. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `error.code` when it is a string, `null` otherwise (no code, a thrown string, a thrown `null`). */
export function errorCode(error: unknown): string | null {
  const code = isObject(error) ? error['code'] : undefined
  return typeof code === 'string' ? code : null
}

/** `String(error?.message ?? error)` — the text used in warnings and log lines. */
export function thrownMessage(error: unknown): string {
  return thrownField(error, 'message')
}

/** `String(error?.stack ?? error)` — the full diagnostic kept for the crash bucket. */
export function thrownStack(error: unknown): string {
  return thrownField(error, 'stack')
}

function thrownField(error: unknown, field: 'message' | 'stack'): string {
  if (isObject(error)) {
    const value = error[field]
    if (value !== undefined && value !== null) return String(value)
  }
  return String(error)
}
