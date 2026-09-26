/**
 * The status route's answer, turned into what the panel renders.
 *
 * The parsing itself is not repeated here: `src/wire.ts` owns the frozen
 * envelope, and the browser half reads it through `parseEnvelope`, so host and
 * browser cannot drift apart. What lives here is the panel's own reading of a
 * parsed record — deduplicated and sorted variables, the credential roster, the
 * value map — frozen so a render can never mutate a poll's answer.
 */

import { SENSITIVE } from './constants.ts'
import type { StatusRecord } from '../src/types.ts'
import { parseEnvelope } from '../src/wire.ts'

export interface ViewVariable {
  readonly name: string
  readonly sensitive: boolean
  readonly hasValue: boolean
}

export interface ViewRecord {
  readonly dir: string
  readonly state: string
  readonly at: number | null
  readonly ms: number | null
  readonly envrcPath: string | null
  readonly memoHit: boolean
  readonly variables: readonly ViewVariable[]
  readonly pathAdditions: readonly string[]
  readonly credentials: readonly string[]
  readonly errorSummary: string | null
  readonly warnings: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>> | null
}

export interface StatusBody {
  readonly record: ViewRecord | null
}

function variablesOf(record: StatusRecord): readonly ViewVariable[] {
  const byName = new Map<string, ViewVariable>()
  for (const item of record.variables) {
    if (byName.has(item.name)) continue
    byName.set(item.name, {
      name: item.name,
      sensitive: item.sensitive === true || SENSITIVE.test(item.name),
      hasValue: item.hasValue !== false,
    })
  }
  // A record that lists no names but does carry a value map still has variables
  // to show: the names are the map's keys.
  if (byName.size === 0 && record.env !== null) {
    for (const [name, value] of Object.entries(record.env)) {
      byName.set(name, { name: name, sensitive: SENSITIVE.test(name), hasValue: value !== undefined && value !== null })
    }
  }
  const variables = [...byName.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
  return Object.freeze(variables)
}

/** Declared credentials win; otherwise the roster is the sensitive-looking names. */
function credentialsOf(record: StatusRecord, variables: readonly ViewVariable[]): readonly string[] {
  if (record.credentials.length > 0) return Object.freeze([...record.credentials])
  return Object.freeze(variables.filter((variable) => variable.sensitive).map((variable) => variable.name))
}

export function toViewRecord(record: StatusRecord): ViewRecord {
  const variables = variablesOf(record)
  return Object.freeze({
    dir: record.dir,
    state: record.state,
    at: record.at,
    ms: record.ms,
    envrcPath: record.envrcPath,
    memoHit: record.memoHit === true,
    variables: variables,
    pathAdditions: Object.freeze([...record.pathAdditions]),
    credentials: credentialsOf(record, variables),
    errorSummary: record.errorSummary,
    warnings: Object.freeze([...record.warnings]),
    env: record.env,
  })
}

/**
 * Read a poll's body.
 *
 * `status: null` is the host's "no workspace directory for this session yet"
 * answer — a normal state, not a transport failure — and only `undefined` means
 * "no envelope here, read the body itself": `parseEnvelope` keeps that
 * distinction, so a flat record still renders while `status: null` never gets
 * folded back into the envelope. A body that is not a record at all answers
 * `null`, and the caller turns that into a failed poll; the web carrier answers
 * unknown paths with the SPA document, and that is a failure disguised as a 200.
 */
export function readStatusBody(payload: unknown): StatusBody | null {
  const envelope = parseEnvelope(payload)
  if (envelope === null) return null
  return { record: envelope.status === null ? null : toViewRecord(envelope.status) }
}
