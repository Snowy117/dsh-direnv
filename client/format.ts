/**
 * Pure formatting: no state, no DOM, no host services.
 *
 * Every function answers `null` (or `''`) for an input it cannot render, because
 * every caller puts the result straight into a row that may not exist at all.
 */

/** The mask a value wears until the operator expands its row. */
export const MASK = '\u2022\u2022\u2022\u2022'

/** The first line of a multi-line host message, clipped to `limit` characters. */
export function firstLine(text: string, limit: number): string {
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** `head…tail`, so a long path keeps both its root and its leaf visible. */
export function ellipsizeMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text
  const keep = Math.max(1, limit - 1)
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** `null` for anything that is not a duration, so the row is simply left out. */
export function formatMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

/** The host's timestamp in the reader's own clock, or `null` when it is unusable. */
export function formatClock(at: number | null): string | null {
  if (at === null || !Number.isFinite(at) || at <= 0) return null
  try {
    return new Date(at).toLocaleTimeString()
  } catch {
    return null
  }
}

/**
 * The de-duplication key for problem notifications: one toast per state+detail
 * pair, so a workspace that stays blocked is announced once (see `hub.ts`).
 */
export function problemDigest(state: string, detail: string): string {
  return `${state}|${detail}`
}
