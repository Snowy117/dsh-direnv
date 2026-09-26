/**
 * The status route's wire format — the one contract the host half and the
 * browser half share.
 *
 * `CONTRACTS.md` («`src/status-route.ts` — 面板数据源») freezes the envelope:
 * `{ ok, plugin, sessionId, dir, status, gate, config }`, with `status: null`
 * meaning "this session has no resolvable workspace yet" — a normal answer, not
 * a transport failure. Only `?values=1` makes the host put variable *values*
 * into `status.env`; without it `status.env` is always `null`.
 *
 * Browser-safe by construction: types plus plain-`JSON` narrowing, no `node:*`
 * and no `NodeJS.*`, so the client migration can import this file as-is.
 */

import type { EnvOverlay, PathEntry, StatusRecord, StatusVariable } from './types.ts'

export interface WirePlugin {
  name: string
  version: string
}

/**
 * The `gate` block, exactly as `gate.describe()` serializes.
 *
 * `result` and `elapsedMs` are absent while the evaluation is still in flight:
 * the host sends that object verbatim and `JSON.stringify` drops `undefined`
 * values, so a reader must treat both as optional rather than as `null`.
 */
export interface WireGate {
  dir: string | null
  state: string | null
  result?: string | null | undefined
  elapsedMs?: number | null | undefined
}

/** The `config` block: what the panel may show about the host's settings. */
export interface WireConfig {
  disabledDirs: string[]
  loadTimeoutMs: number
  evaluateTimeoutMs: number
}

export interface StatusEnvelope {
  ok: true
  plugin: WirePlugin | null
  sessionId: string | null
  dir: string | null
  /** `null` = the host has no directory for this session. */
  status: StatusRecord | null
  gate: WireGate | null
  /** Absent on the `dir: null` answer, which the host builds without it. */
  config?: WireConfig | null | undefined
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonObject
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item !== '') out.push(item)
  }
  return out
}

/**
 * Values are `null` unless the request carried `?values=1`, and a tombstone
 * never reaches the wire: `EnvOverlay` marks one with `undefined`, which
 * `JSON.stringify` drops. Anything that is not a string is dropped rather than
 * coerced — the panel shows values, it does not repair them.
 */
function parseEnv(value: unknown): EnvOverlay | null {
  const raw = asObject(value)
  if (raw === null) return null
  const env: EnvOverlay = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') env[name] = entry
  }
  return env
}

function parseVariables(value: unknown): StatusVariable[] {
  if (!Array.isArray(value)) return []
  const out: StatusVariable[] = []
  for (const item of value) {
    const raw = asObject(item)
    if (raw === null) continue
    const name = typeof raw.name === 'string' ? raw.name : ''
    if (name === '') continue
    // `hasValue` defaults to true, matching the panel's own reading: "we were
    // not told otherwise" is not the same claim as "there is no value".
    out.push({ name, sensitive: raw.sensitive === true, hasValue: raw.hasValue !== false })
  }
  return out
}

/**
 * A `PATH` diff is only readable if every entry says *which* of the three things
 * happened, so an entry with an unknown `change` is dropped rather than guessed
 * at — defaulting it to `unchanged` would silently claim nothing happened.
 * `value` may be empty: an empty `PATH` component is a real element, and the
 * panel decides how to draw it.
 */
function parsePathEntries(value: unknown): PathEntry[] {
  if (!Array.isArray(value)) return []
  const out: PathEntry[] = []
  for (const item of value) {
    const raw = asObject(item)
    if (raw === null) continue
    const entry = raw.value
    const change = raw.change
    if (typeof entry !== 'string') continue
    if (change !== 'added' && change !== 'removed' && change !== 'unchanged') continue
    out.push({ value: entry, change })
  }
  return out
}

/**
 * A record is only accepted when `state` is a non-empty string — that is the one
 * field every reader branches on, and the frozen contract names it as the
 * failure line. Everything else is defaulted, because a host that answers with
 * fewer fields is still answering.
 */
function parseRecord(value: unknown, fallbackDir: string | null): StatusRecord | null {
  const raw = asObject(value)
  if (raw === null) return null
  const state = typeof raw.state === 'string' && raw.state !== '' ? raw.state : null
  if (state === null) return null
  const envrcPath = nonEmptyStringOrNull(raw.envrcPath)
  const errorSummary = typeof raw.errorSummary === 'string' && raw.errorSummary.trim() !== '' ? raw.errorSummary : null
  return {
    dir: typeof raw.dir === 'string' ? raw.dir : (fallbackDir ?? ''),
    state: state as StatusRecord['state'],
    at: finiteOrNull(raw.at),
    ms: finiteOrNull(raw.ms),
    envrcPath,
    memoHit: raw.memoHit === true,
    variables: parseVariables(raw.variables),
    pathEntries: parsePathEntries(raw.pathEntries),
    credentials: strings(raw.credentials),
    errorSummary,
    warnings: strings(raw.warnings),
    watchCount: finiteOrNull(raw.watchCount) ?? 0,
    env: parseEnv(raw.env),
  }
}

function parseGate(value: unknown): WireGate | null {
  const raw = asObject(value)
  if (raw === null) return null
  // Both optional fields normalize to `null` rather than staying absent, so a
  // reader never has to tell "the host did not send it" from "the host sent
  // nothing": `undefined` only ever means "not parsed yet".
  return {
    dir: typeof raw.dir === 'string' ? raw.dir : null,
    state: typeof raw.state === 'string' ? raw.state : null,
    result: typeof raw.result === 'string' ? raw.result : null,
    elapsedMs: finiteOrNull(raw.elapsedMs),
  }
}

function parseConfig(value: unknown): WireConfig | null {
  const raw = asObject(value)
  if (raw === null) return null
  return {
    disabledDirs: strings(raw.disabledDirs),
    loadTimeoutMs: finiteOrNull(raw.loadTimeoutMs) ?? 0,
    evaluateTimeoutMs: finiteOrNull(raw.evaluateTimeoutMs) ?? 0,
  }
}

function parsePlugin(value: unknown): WirePlugin | null {
  const raw = asObject(value)
  if (raw === null) return null
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (name === '') return null
  return { name, version: typeof raw.version === 'string' ? raw.version : '' }
}

/**
 * The parsing boundary: `JSON.parse` output in, a validated envelope out, or
 * `null` when the body is not an answer to this route at all (the web carrier
 * answers unknown paths with the SPA document, and `JSON.parse` of that throws
 * before we get here).
 *
 * The flat-record branch is deliberate: the reader must accept a body that *is*
 * a `StatusRecord`, which is what an unwrapped host or a future route version
 * would send. An envelope is recognized by `ok`/`status`; without either, the
 * body itself is read as the record.
 */
export function parseEnvelope(body: unknown): StatusEnvelope | null {
  const root = asObject(body)
  if (root === null) return null
  if (root.ok === false) return null

  const dir = typeof root.dir === 'string' ? root.dir : null
  const statusField = root.status
  const record = statusField === undefined && root.ok === undefined ? root : statusField
  let status: StatusRecord | null = null
  if (record !== undefined && record !== null) {
    status = parseRecord(record, dir)
    if (status === null) return null
  }

  return {
    ok: true,
    plugin: parsePlugin(root.plugin),
    sessionId: typeof root.sessionId === 'string' ? root.sessionId : null,
    dir,
    status,
    gate: parseGate(root.gate),
    config: parseConfig(root.config),
  }
}
