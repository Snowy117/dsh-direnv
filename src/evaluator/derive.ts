/**
 * The sidebar's facts, derived from an `ok` overlay.
 *
 * Two rules are load-bearing:
 *
 * - **Values never leave this module.** `variables` reports a name, whether it
 *   looks sensitive, and whether it has a value; masking the value is the
 *   client's decision. `credentials` are names too — the status route only ever
 *   ships them when the operator explicitly asked for values.
 * - **`pathEntries` are a diff against the base `PATH`**, not the absolute list
 *   (which is already visible in the overlay). The order is the *new* `PATH`'s
 *   order, because "earlier means higher priority" is the only way a reader can
 *   interpret the list; a base-only component is emitted before the next new
 *   component the walk pairs up, so a removal reads in place only while the new
 *   `PATH` keeps the base order — a reordering can surface it next to components
 *   that were never its neighbours.
 */

import type { DerivedFacts, Overlay, PathEntry, StatusVariable } from '../types.ts'

/** Same credential heuristic the harness uses (substring, case-insensitive). */
const SENSITIVE_NAME = /KEY|PASSWORD|SECRET|TOKEN/i

export function deriveFacts(overlay: Overlay, basePath: string | undefined): DerivedFacts {
  const variables: StatusVariable[] = []
  const credentials: string[] = []
  for (const [name, value] of Object.entries(overlay)) {
    const sensitive = SENSITIVE_NAME.test(name)
    if (sensitive) credentials.push(name)
    variables.push({ name, sensitive, hasValue: typeof value === 'string' && value !== '' })
  }
  variables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  credentials.sort()
  return { variables, credentials, pathEntries: diffPathEntries(overlay.PATH, basePath) }
}

/**
 * The ordered, multiset-aware `PATH` diff.
 *
 * A `PATH` is a *list*, not a set: the same directory may legitimately appear
 * twice, and each occurrence is its own priority slot. So occurrences pair up by
 * count — the k-th occurrence of a component in the new `PATH` is `unchanged`
 * only while the base has a k-th occurrence to pair it with, and the k-th
 * occurrence beyond the new count is what got `removed`.
 *
 * Interleaving: walk the new list, pairing each new component with an unmatched
 * base occurrence at or after the cursor; a pairing that skips over unmatched
 * base components emits them first. A removal therefore lands next to its old
 * neighbours only while the new `PATH` keeps the base order — after a reordering
 * it surfaces before whichever new component the walk reaches next. Whatever
 * base entries remain are appended at the end, which is where a `PATH`
 * shortening shows up.
 */
function diffPathEntries(value: unknown, basePath: string | undefined): PathEntry[] {
  if (typeof value !== 'string') return []
  const next = value.split(':')
  const base = typeof basePath === 'string' ? basePath.split(':') : []
  const newCounts = counts(next)
  const baseCounts = counts(base)

  const seenInNew = new Map<string, number>()
  const planned: PathEntry[] = next.map((item) => {
    const seen = (seenInNew.get(item) ?? 0) + 1
    seenInNew.set(item, seen)
    return { value: item, change: seen <= (baseCounts.get(item) ?? 0) ? 'unchanged' : 'added' }
  })

  const seenInBase = new Map<string, number>()
  const removedInBase = base.map((item) => {
    const seen = (seenInBase.get(item) ?? 0) + 1
    seenInBase.set(item, seen)
    return seen > (newCounts.get(item) ?? 0)
  })

  const entries: PathEntry[] = []
  let cursor = 0
  for (const step of planned) {
    const match = base.findIndex((candidate, at) => at >= cursor && candidate === step.value && !removedInBase[at])
    if (match !== -1) {
      for (let at = cursor; at < match; at += 1) {
        const candidate = base[at]
        if (candidate !== undefined && removedInBase[at] === true) entries.push({ value: candidate, change: 'removed' })
      }
      cursor = match + 1
    }
    entries.push(step)
  }
  for (let at = cursor; at < base.length; at += 1) {
    const candidate = base[at]
    if (candidate !== undefined && removedInBase[at] === true) entries.push({ value: candidate, change: 'removed' })
  }
  return entries
}

function counts(items: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1)
  return out
}
