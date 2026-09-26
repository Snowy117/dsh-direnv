/**
 * The `unknown`-narrowing seams the test harness reads values through.
 *
 * Everything the client bundle hands back — a module definition, a registration,
 * a hook value, a `JSON.parse` result — arrives as `unknown` in this project, so
 * every read of it goes through one of these guards instead of a cast.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Any callback the harness calls: hook initializers, state updaters, effect
 * cleanups, DOM event handlers. Their signatures are the caller's business, and
 * the harness only ever calls them the way the caller itself arranged.
 */
export function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}
