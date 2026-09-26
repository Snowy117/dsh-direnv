/**
 * The sidebar's facts, derived from an `ok` overlay.
 *
 * Two rules are load-bearing:
 *
 * - **Values never leave this module.** `variables` reports a name, whether it
 *   looks sensitive, and whether it has a value; masking the value is the
 *   client's decision. `credentials` are names too — the status route only ever
 *   ships them when the operator explicitly asked for values.
 * - **`pathAdditions` are relative to the base `PATH`**, i.e. what direnv added,
 *   because that is what "direnv changed PATH" means to whoever reads the panel;
 *   the absolute list is already visible in the overlay.
 */

import type { DerivedFacts, Overlay, StatusVariable } from '../types.ts'

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
  return { variables, credentials, pathAdditions: pathAdditions(overlay, basePath) }
}

function pathAdditions(overlay: Overlay, basePath: string | undefined): string[] {
  const value = overlay.PATH
  if (typeof value !== 'string') return []
  const known = new Set(String(basePath ?? '').split(':').filter(Boolean))
  const added: string[] = []
  const seen = new Set<string>()
  for (const entry of value.split(':').filter(Boolean)) {
    if (known.has(entry) || seen.has(entry)) continue
    seen.add(entry)
    added.push(entry)
  }
  return added
}
