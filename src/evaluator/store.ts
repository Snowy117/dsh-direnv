/**
 * The record table: memo lookups, in-flight dedup, and the sidebar's snapshot.
 *
 * Two invariants the rest of the plugin leans on:
 *
 * - **One evaluation per directory.** The table and the in-flight map are keyed
 *   by canonical directory, and a second caller for the same directory joins the
 *   first promise instead of starting a second direnv child — four concurrent
 *   prewarms must produce exactly one process.
 * - **A transient failure is not a conclusion.** `peek` answers `{}`
 *   ("evaluated, nothing to inject") only for a determinate kind, and
 *   `undefined` ("unknown, worth retrying") for `error`. Mixing those two up is
 *   what makes a slow `.envrc` either never retried or retried per subprocess.
 */

import path from 'node:path'

import type { CanonicalDir, EvaluationRecord, NoEnv, PeekEnvResult, StatusRecord } from '../types.ts'

/**
 * The record table's key function. Anything that is not a non-empty string has
 * no directory at all (`null`); `path.resolve` itself cannot fail for a string.
 */
export function canonDir(dir: unknown): CanonicalDir | null {
  if (typeof dir !== 'string' || dir === '') return null
  try {
    return path.resolve(dir) as CanonicalDir
  } catch {
    return null
  }
}

/** A fresh empty answer: `NoEnv` is handed to callers, so it may not be shared. */
export function noEnv(): NoEnv {
  return {}
}

export interface RecordStore {
  get(key: CanonicalDir): EvaluationRecord | undefined
  save(key: CanonicalDir, record: EvaluationRecord): EvaluationRecord
  drop(key: CanonicalDir): void
  clear(): void
  isInFlight(key: CanonicalDir): boolean
  inFlightDirs(): readonly string[]
  /** Same-directory dedup: a second caller joins the evaluation already running. */
  join(key: CanonicalDir, start: () => Promise<EvaluationRecord>): Promise<EvaluationRecord>
}

export function createRecordStore(): RecordStore {
  /** canonical dir -> record (last conclusion, reused when its key still matches) */
  const records = new Map<CanonicalDir, EvaluationRecord>()
  /** canonical dir -> in-flight Promise<EvaluationRecord> (same dir is evaluated once) */
  const pending = new Map<CanonicalDir, Promise<EvaluationRecord>>()

  return {
    get(key) {
      return records.get(key)
    },
    save(key, record) {
      records.set(key, record)
      return record
    },
    drop(key) {
      records.delete(key)
    },
    clear() {
      records.clear()
    },
    isInFlight(key) {
      return pending.has(key)
    },
    inFlightDirs() {
      return [...pending.keys()]
    },
    join(key, start) {
      const existing = pending.get(key)
      if (existing) return existing
      const promise = start().finally(() => {
        if (pending.get(key) === promise) pending.delete(key)
      })
      pending.set(key, promise)
      return promise
    },
  }
}

export function peek(store: RecordStore, dir: string, memoEnabled: boolean): PeekEnvResult {
  if (!memoEnabled) return undefined
  const key = canonDir(dir)
  if (key === null) return undefined
  const record = store.get(key)
  if (!record) return undefined
  switch (record.kind) {
    // `ok` is the only kind carrying something injectable.
    case 'ok':
      return { ...record.env }
    // `error` is the transient bucket (timeout, killed, spawn failure, crash,
    // bad JSON, overflow): `undefined` makes the next spawn prewarm again, so a
    // slow or failed run still gets its chance.
    case 'error':
      return undefined
    // Every other kind is a determinate conclusion, so `{}` — "evaluated,
    // nothing to inject" — stops `spawn()` from prewarming on every subprocess.
    case 'absent':
    case 'unreadable':
    case 'disabled':
    case 'blocked':
    case 'envrc-failed':
    case 'config-error':
    case 'direnv-unavailable':
      return noEnv()
  }
}

export function statusOf(store: RecordStore, dir: string, memoEnabled: boolean): StatusRecord {
  const key = canonDir(dir)
  const loading = key !== null && store.isInFlight(key)
  const record = key === null ? undefined : store.get(key)
  if (!record) {
    return {
      dir: String(dir ?? ''),
      state: loading ? 'loading' : 'idle',
      at: null,
      ms: null,
      envrcPath: null,
      memoHit: false,
      watchCount: 0,
      variables: [],
      pathAdditions: [],
      credentials: [],
      errorSummary: null,
      warnings: [],
      env: null,
    }
  }
  const facts = record.kind === 'ok' ? record.derived : null
  return {
    dir: record.dir,
    state: loading ? 'loading' : record.kind,
    at: record.at,
    ms: record.ms,
    envrcPath: record.envrcPath,
    memoHit: memoEnabled && record.memoHit,
    watchCount: record.kind === 'ok' && record.watches !== null ? record.watches.length : 0,
    variables: facts ? facts.variables.map((entry) => ({ ...entry })) : [],
    pathAdditions: facts ? [...facts.pathAdditions] : [],
    credentials: facts ? [...facts.credentials] : [],
    errorSummary: record.errorSummary,
    warnings: [...record.warnings],
    env: record.kind === 'ok' || record.kind === 'disabled' ? { ...record.env } : null,
  }
}
