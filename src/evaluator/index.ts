/**
 * `createEvaluator` — the evaluator's only public seam.
 *
 * Orchestration, memo lookup and the record table wiring live here; the work
 * itself lives in the siblings: `spawn.ts` (the child), `classify.ts` (raw run →
 * record), `fingerprint.ts` (the memo key), `envrc.ts` (RC probing),
 * `watches.ts` (`DIRENV_WATCHES`), `derive.ts` (sidebar facts), `store.ts`
 * (records + in-flight dedup), `deps.ts` (the injected seam), `errors.ts`.
 *
 * Boundaries this module owns:
 *
 * - **Two independent budgets.** How long the *tool gate* may wait is the gate's
 *   business (`loadTimeoutMs`, `src/gate.js`); how long a direnv child may live
 *   is ours (`evaluateTimeoutMs`). They used to be the same number, which meant
 *   a gate timeout also killed the evaluation and a slow `.envrc` never produced
 *   an environment — and because a killed run leaves a non-ok record, the spawn
 *   path stopped retrying entirely (DESIGN.md §7.2).
 * - **No memo is left to direnv.** direnv has no cross-process cache: the RC
 *   really runs on every call, so the memo — and the in-flight dedup that keeps
 *   concurrent callers from each starting a child — is ours.
 * - **Anti-recursion.** direnv is spawned through `deps.spawnDirenv`, never
 *   through `ctx.subprocess`, which is the very service this plugin replaces.
 *
 * Nothing here throws: every failure is mapped onto an `Outcome`, and the public
 * methods keep their documented "never rejects" behaviour even when an injected
 * dependency, or the logger, explodes.
 */

import {
  abortedRecord,
  classifyRun,
  crashRecord,
  disabledRecord,
  invalidDirRecord,
  overflowedRecord,
  spawnFailureRecord,
  stripAnsi,
  timedOutRecord,
  unavailableRecord,
} from './classify.ts'
import type { Stamp } from './classify.ts'
import { baseEnv, hashString, nowMs, resolveDeps } from './deps.ts'
import { findEnvrc } from './envrc.ts'
import { errorCode, thrownMessage, thrownStack } from './errors.ts'
import { createFingerprinter } from './fingerprint.ts'
import type { MemoInput } from './fingerprint.ts'
import { DEFAULT_EVALUATE_TIMEOUT_MS, MAX_OUTPUT_BYTES } from './spawn.ts'
import { canonDir, createRecordStore, noEnv, peek, statusOf } from './store.ts'
import type {
  AbsentOutcome,
  BlockedOutcome,
  ConfigErrorOutcome,
  DirenvUnavailableOutcome,
  DirEntryStat,
  DisabledOutcome,
  ErrorOutcome,
  ErrorRecord,
  EvaluateRequest,
  EvaluationRecord,
  Evaluator,
  EvaluatorOptions,
  LogFn,
  LogLevel,
  Outcome,
  OutcomeCore,
  PeekEnvResult,
  PrewarmRequest,
  SpawnDirenvResult,
  UnreadableOutcome,
} from '../types.ts'

/** The memo key of a record is only known after it is classified; this is its placeholder. */
const PENDING_KEY = 'PENDING'

/**
 * `signal?.aborted`, read as a function call because the flag can flip while the
 * child runs: control-flow analysis would otherwise treat the pre-spawn check as
 * proof that it is still false after the spawn.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

type RunResult = { aborted: true; record: ErrorRecord } | { aborted: false; record: EvaluationRecord }

export function createEvaluator(options: EvaluatorOptions = {}): Evaluator {
  const logFn: LogFn | null = typeof options.log === 'function' ? options.log : null
  const memoEnabled = options.memo !== false
  const requested: unknown = options.evaluateTimeoutMs ?? options.loadTimeoutMs
  const evaluateTimeoutMs =
    Number.isFinite(requested) && Number(requested) > 0 ? Number(requested) : DEFAULT_EVALUATE_TIMEOUT_MS
  const isDirDisabled = typeof options.isDirDisabled === 'function' ? options.isDirDisabled : null
  const deps = resolveDeps(options.deps)
  const direnvPath = typeof options.direnvPath === 'string' && options.direnvPath !== '' ? options.direnvPath : null
  const fingerprinter = createFingerprinter({ deps, direnvPath })
  const store = createRecordStore()

  function log(level: LogLevel, message: string, extra?: object): void {
    if (logFn === null) return
    try {
      logFn(level, message, extra)
    } catch {
      /* a broken logger must never break evaluation */
    }
  }

  /** What the memo key may take from a conclusion: its watches and the RC path it reported. */
  function memoInput(record: EvaluationRecord | undefined): MemoInput | null {
    if (record === undefined) return null
    return { envrcPath: record.envrcPath, watches: record.kind === 'ok' ? record.watches : null }
  }

  async function runOnce(
    dir: string,
    previous: EvaluationRecord | undefined,
    request: EvaluateRequest | undefined,
  ): Promise<RunResult> {
    const started = nowMs(deps)
    const base = baseEnv(deps)
    const signal = request?.signal
    const stampNow = (): Stamp => ({ ms: nowMs(deps) - started, at: nowMs(deps) })

    if (isAborted(signal)) {
      return { aborted: true, record: abortedRecord(dir, PENDING_KEY, stampNow(), null) }
    }

    // Node reports ENOENT for both "direnv missing" and "cwd missing", with
    // err.path pointing at direnv; stat the directory ourselves to tell them
    // apart, and catch ENOTDIR here (a file as cwd).
    let dirStat: DirEntryStat | null = null
    try {
      dirStat = await deps.stat(dir)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') {
        return {
          aborted: false,
          record: unavailableRecord(
            dir,
            PENDING_KEY,
            code,
            code === 'ENOTDIR' ? 'cwd-not-a-directory' : 'cwd-missing',
            stampNow(),
          ),
        }
      }
    }
    if (dirStat && typeof dirStat.isDirectory === 'function' && !dirStat.isDirectory()) {
      return {
        aborted: false,
        record: unavailableRecord(dir, PENDING_KEY, 'ENOTDIR', 'cwd-not-a-directory', stampNow()),
      }
    }

    const binary = await fingerprinter.resolveBinary(base)
    let result: SpawnDirenvResult
    try {
      result = await deps.spawnDirenv(binary, ['export', 'json'], {
        cwd: dir,
        env: base,
        stdin: 'ignore',
        signal,
        timeoutMs: evaluateTimeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      })
    } catch (error) {
      return { aborted: false, record: spawnFailureRecord(dir, PENDING_KEY, error, stampNow()) }
    }

    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    const stderr = stripAnsi(typeof result.stderr === 'string' ? result.stderr : '')
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null
    const stamp: Stamp = { ms: nowMs(deps) - started, at: nowMs(deps) }

    if (result.aborted === true || isAborted(signal)) {
      return { aborted: true, record: abortedRecord(dir, PENDING_KEY, stamp, exitCode) }
    }
    if (result.timedOut === true) {
      return { aborted: false, record: timedOutRecord(dir, PENDING_KEY, stamp, exitCode, evaluateTimeoutMs) }
    }
    if (result.overflow === true) {
      return { aborted: false, record: overflowedRecord(dir, PENDING_KEY, stamp, exitCode, MAX_OUTPUT_BYTES) }
    }

    // Probed only now: a timeout, an abort or an overflow says nothing about the
    // RC, and probing it would be an extra stat on a path that has no answer.
    const envrc = await findEnvrc(deps, dir, previous?.envrcPath ?? null)
    return {
      aborted: false,
      record: classifyRun({ dir, key: PENDING_KEY, base, envrc, stdout, stderr, exitCode, stamp }),
    }
  }

  async function ensureEvaluated(dir: string, request: EvaluateRequest | undefined): Promise<EvaluationRecord> {
    const key = canonDir(dir)
    if (key === null) {
      return invalidDirRecord(String(dir), 'invalid', { ms: 0, at: nowMs(deps) })
    }

    if (isDirDisabled !== null) {
      let disabled = false
      try {
        disabled = isDirDisabled(key) === true
      } catch {
        disabled = false
      }
      if (disabled) {
        return store.save(key, disabledRecord(key, hashString(deps, `disabled:${key}`), { ms: 0, at: nowMs(deps) }))
      }
    }

    const previous = store.get(key)
    const force = request?.force === true

    if (!force && memoEnabled && previous && previous.reusable) {
      let computed: string | null = null
      try {
        computed = await fingerprinter.memoKey(key, memoInput(previous))
      } catch {
        computed = null
      }
      if (computed !== null && computed === previous.key) {
        previous.memoHit = true
        log('debug', `direnv memo hit for ${key}`, { kind: previous.kind })
        return previous
      }
    }

    return store.join(key, async () => {
      const started = nowMs(deps)
      let result: RunResult
      try {
        result = await runOnce(key, previous, request)
      } catch (error) {
        log('error', `direnv evaluation crashed for ${key}`, { error: thrownStack(error) })
        return store.save(key, crashRecord(key, hashString(deps, `crash:${nowMs(deps)}`), error, {
          ms: nowMs(deps) - started,
          at: nowMs(deps),
        }))
      }
      if (result.aborted) {
        log('debug', `direnv evaluation aborted for ${key}`)
        return result.record // never recorded: an aborted run says nothing about the dir
      }
      let recordKey: string
      try {
        recordKey = await fingerprinter.memoKey(key, memoInput(result.record))
      } catch {
        recordKey = hashString(deps, `nokey:${key}:${nowMs(deps)}`)
      }
      result.record.key = recordKey
      const record = store.save(key, result.record)
      log(record.kind === 'ok' ? 'debug' : 'warn', `direnv ${record.kind} for ${key}`, {
        ms: record.ms,
        envrcPath: record.envrcPath,
        warnings: record.warnings.length,
      })
      return record
    })
  }

  async function ensureEnv(dir: string, request?: EvaluateRequest): Promise<PeekEnvResult> {
    try {
      const record = await ensureEvaluated(dir, request)
      if (record.kind === 'ok') return { ...record.env }
      return noEnv()
    } catch (error) {
      log('error', `ensureEnv failed for ${dir}`, { error: thrownMessage(error) })
      return undefined
    }
  }

  async function evaluate(dir: string, request?: EvaluateRequest): Promise<Outcome> {
    try {
      const record = await ensureEvaluated(dir, request)
      return publicOutcome(record)
    } catch (error) {
      log('error', `evaluate failed for ${dir}`, { error: thrownMessage(error) })
      const at = nowMs(deps)
      return {
        kind: 'error',
        dir: String(dir),
        stderr: thrownStack(error),
        exitCode: null,
        ms: 0,
        at,
      }
    }
  }

  return {
    peekEnv(dir) {
      return peek(store, dir, memoEnabled)
    },
    ensureEnv,
    evaluate,
    prewarm(dir: string, request?: PrewarmRequest) {
      return ensureEnv(dir, request).then(
        () => undefined,
        () => undefined,
      )
    },
    invalidate(dir) {
      if (dir === undefined || dir === null) {
        store.clear()
        return
      }
      const key = canonDir(dir)
      if (key !== null) store.drop(key)
    },
    status(dir) {
      return statusOf(store, dir, memoEnabled)
    },
    inFlight() {
      return store.inFlightDirs()
    },
  }
}

/**
 * The published projection of a record. Independent copies on purpose: `peekEnv`
 * and `status()` hand their results to the caller, and a caller that mutates one
 * must not be able to corrupt the stored record or the next spawn.
 */
function publicOutcome(record: EvaluationRecord): Outcome {
  const base = { dir: record.dir, ms: record.ms, at: record.at }
  switch (record.kind) {
    case 'ok':
      return {
        kind: 'ok',
        dir: record.dir,
        envrcPath: record.envrcPath,
        overlay: { ...record.overlay },
        env: { ...record.env },
        degraded: record.degraded,
        warnings: [...record.warnings],
        watches: record.watches === null ? null : record.watches.map((watch) => ({ ...watch })),
        ms: record.ms,
        at: record.at,
        memoHit: record.memoHit,
      }
    case 'absent':
      return withWarnings<AbsentOutcome>({ kind: 'absent', ...base }, record)
    case 'disabled':
      return withWarnings<DisabledOutcome>({ kind: 'disabled', dir: record.dir, at: record.at }, record)
    case 'unreadable':
      return withWarnings<UnreadableOutcome>({ kind: 'unreadable', envrcPath: record.envrcPath, ...base }, record)
    case 'blocked':
      return withWarnings<BlockedOutcome>(
        { kind: 'blocked', envrcPath: record.envrcPath, stderr: record.stderr, ...base },
        record,
      )
    case 'envrc-failed':
      return withWarnings(
        { kind: 'envrc-failed', status: record.status, stderr: record.stderr, ...base },
        record,
      )
    case 'config-error':
      return withWarnings<ConfigErrorOutcome>({ kind: 'config-error', stderr: record.stderr, ...base }, record)
    case 'direnv-unavailable':
      return withWarnings<DirenvUnavailableOutcome>({ kind: 'direnv-unavailable', code: record.code, ...base }, record)
    case 'error':
      return withWarnings<ErrorOutcome>(
        { kind: 'error', stderr: record.stderr, exitCode: record.exitCode, ...base },
        record,
      )
  }
}

/** `warnings` / `reason` are additive: only present when there is something to say. */
function withWarnings<T extends OutcomeCore>(outcome: T, record: EvaluationRecord): T {
  if (record.warnings.length > 0) outcome.warnings = [...record.warnings]
  if (record.reason) outcome.reason = record.reason
  return outcome
}
