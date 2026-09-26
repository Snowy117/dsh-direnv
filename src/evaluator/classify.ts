/**
 * Classification: `(stderr, exit status, stdout)` → one `EvaluationRecord`.
 *
 * The rules here are the ones that may not be simplified:
 *
 * - On a non-zero exit **stdout is never parsed**: both "blocked" and an RC's
 *   own `exit N` leave a perfectly valid JSON diff on stdout, and parsing it
 *   would smuggle a blocked workspace's variables into every subprocess
 *   (`test/evaluator.test.mjs`, "non-zero exit: stdout is never parsed").
 * - `blocked` needs **exactly one** `direnv: error … is blocked. Run
 *   \`direnv allow\`…` line, and the line must match the template. An RC can
 *   print a convincing fake, but then the real one is there too and the count is
 *   > 1; an ambiguous stderr degrades to the transient `error` bucket instead of
 *   a forged fact.
 * - Empty stdout is disambiguated by our own stat (see `envrc.ts`), never
 *   guessed.
 * - Exit 0 JSON is a *diff*: `null` → tombstone (`undefined`), a missing key →
 *   leave the variable alone, and every `DIRENV_*` key is dropped, because
 *   replaying direnv's load state resurrects secrets the harness scrubbed.
 */

import { DIRENV_KEY } from './deps.ts'
import { deriveFacts } from './derive.ts'
import { errorCode, thrownMessage, thrownStack } from './errors.ts'
import { decodeWatches } from './watches.ts'
import type { EnvrcProbe } from './envrc.ts'
import type {
  BlockedRecord,
  DirenvBaseEnv,
  DisabledRecord,
  ErrorRecord,
  EnvOverlay,
  EnvrcFailedRecord,
  EvaluationRecord,
  OkRecord,
  OutcomeKind,
  Overlay,
  RecordCore,
  UnavailableRecord,
} from '../types.ts'

/** stderr is always ANSI-coloured, even with NO_COLOR / TERM=dumb ("nothing
 *  measured turns it off"), so classification strips colour first. */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

export function stripAnsi(value: unknown): string {
  return typeof value === 'string' ? value.replace(ANSI, '') : ''
}

/** The only stable "blocked" evidence: a single `direnv: error` line matching
 *  the template. `.envrc` can print a fake line, but then the real one is there
 *  too, so the line count is >1. */
const BLOCKED_LINE = /is blocked\. Run `direnv allow` to approve its content$/
const ERROR_LINE = /^direnv: error (.*)$/gm
const BLOCKED_PATH = /^direnv: error (.*) is blocked\./
const EXIT_STATUS_LINE = /^direnv: error exit status (\d+)$/
const LOAD_CONFIG = /LoadConfig\(\) failed to parse/

/** Benign stderr chatter on a successful run. Anything else is noise. */
const BENIGN_LINE = /^direnv: (loading|export|unloading)\b/

/**
 * Kinds whose conclusion is a pure function of the memo key, so a key match may
 * reuse it. `error` is never reused (a later attempt may succeed) and an aborted
 * run is not recorded at all. `direnv-unavailable` is re-run when asked, even
 * though `peek` treats it as a determinate conclusion: a missing binary or cwd
 * cannot change between subprocesses, but it can change before a reload.
 */
const REUSABLE_KINDS: Readonly<Record<OutcomeKind, boolean>> = {
  ok: true,
  absent: true,
  unreadable: true,
  disabled: true,
  blocked: true,
  'envrc-failed': true,
  'config-error': true,
  error: false,
  'direnv-unavailable': false,
}

/** When a conclusion was reached: `ms` spent, `at` wall clock — stamped by the caller. */
export interface Stamp {
  ms: number
  at: number
}

interface CoreFields {
  reason?: string | null
  warnings?: string[]
  stderr?: string
  envrcPath?: string | null
  /** `envrc-failed`: the RC's own exit status, rendered into the summary. */
  status?: number | null
  /** `direnv-unavailable`: the errno code, rendered into the summary. */
  code?: string | null
}

export function noiseLines(value: string): string[] {
  return stripAnsi(value)
    .split('\n')
    .filter((line) => line !== '' && !BENIGN_LINE.test(line))
}

export function truncate(value: unknown, max = 200): string {
  if (typeof value !== 'string') return ''
  const line = stripAnsi(value).split('\n').find((entry) => entry.trim() !== '') ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function summarize(kind: OutcomeKind, fields: CoreFields): string | null {
  switch (kind) {
    case 'blocked':
      return `blocked: ${fields.envrcPath ?? 'unknown .envrc'}`
    case 'envrc-failed':
      return `exit status ${fields.status}`
    case 'unreadable':
      return `unreadable: ${fields.envrcPath}`
    case 'direnv-unavailable':
      return `direnv unavailable (${fields.code})`
    case 'config-error':
      return truncate(noiseLines(fields.stderr ?? '')[0] ?? '') || 'direnv.toml failed to parse'
    case 'error':
      if (fields.reason === 'ambiguous-exit-status') return 'ambiguous exit status (stderr is not trustworthy)'
      return truncate(noiseLines(fields.stderr ?? '')[0] ?? '') || 'direnv failed'
    default:
      return null
  }
}

function core(dir: string, key: string, kind: OutcomeKind, stamp: Stamp, fields: CoreFields): RecordCore {
  const stderr = fields.stderr ?? ''
  return {
    dir,
    key,
    ms: stamp.ms,
    at: stamp.at,
    memoHit: false,
    reusable: REUSABLE_KINDS[kind],
    warnings: fields.warnings ?? noiseLines(stderr),
    reason: fields.reason ?? null,
    errorSummary: summarize(kind, fields),
  }
}

export function unavailableRecord(
  dir: string,
  key: string,
  code: string,
  reason: string,
  stamp: Stamp,
): UnavailableRecord {
  return {
    ...core(dir, key, 'direnv-unavailable', stamp, { code, reason, warnings: reason ? [reason] : [] }),
    kind: 'direnv-unavailable',
    envrcPath: null,
    code,
  }
}

/**
 * The child never started. Node reports ENOENT for both "direnv missing" and
 * "cwd missing", with `err.path` pointing at direnv, so those two codes are
 * errno facts about the *binary or the directory* and are classified as
 * `direnv-unavailable`; anything else is the generic transient `spawn-failed`.
 */
export function spawnFailureRecord(dir: string, key: string, error: unknown, stamp: Stamp): EvaluationRecord {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
    return unavailableRecord(dir, key, code, `spawn ${code}`, stamp)
  }
  const stderr = thrownMessage(error)
  return {
    ...core(dir, key, 'error', stamp, { stderr, reason: 'spawn-failed', warnings: [truncate(stderr)] }),
    kind: 'error',
    envrcPath: null,
    stderr,
    exitCode: null,
  }
}

/** An aborted run says nothing about the directory, so this record is never stored. */
export function abortedRecord(dir: string, key: string, stamp: Stamp, exitCode: number | null): ErrorRecord {
  const stderr = 'aborted'
  return {
    ...core(dir, key, 'error', stamp, { stderr, reason: 'aborted' }),
    kind: 'error',
    envrcPath: null,
    stderr,
    exitCode,
  }
}

export function timedOutRecord(
  dir: string,
  key: string,
  stamp: Stamp,
  exitCode: number | null,
  timeoutMs: number,
): ErrorRecord {
  const stderr = `direnv did not finish within ${timeoutMs}ms`
  return {
    ...core(dir, key, 'error', stamp, { stderr, reason: 'timeout', warnings: [stderr] }),
    kind: 'error',
    envrcPath: null,
    stderr,
    exitCode,
  }
}

export function overflowedRecord(
  dir: string,
  key: string,
  stamp: Stamp,
  exitCode: number | null,
  maxBuffer: number,
): ErrorRecord {
  const stderr = `direnv output exceeded ${maxBuffer} bytes`
  return {
    ...core(dir, key, 'error', stamp, { stderr, reason: 'max-buffer', warnings: [stderr] }),
    kind: 'error',
    envrcPath: null,
    stderr,
    exitCode,
  }
}

/** `evaluate` was handed something that is not a usable directory path. */
export function invalidDirRecord(dir: string, key: string, stamp: Stamp): ErrorRecord {
  const stderr = 'dir must be a non-empty string'
  return {
    ...core(dir, key, 'error', stamp, { stderr, reason: 'invalid-dir' }),
    kind: 'error',
    envrcPath: null,
    stderr,
    exitCode: null,
  }
}

export function crashRecord(dir: string, key: string, error: unknown, stamp: Stamp): ErrorRecord {
  const stderr = thrownStack(error)
  return {
    ...core(dir, key, 'error', stamp, { reason: 'crash', stderr, warnings: [truncate(thrownMessage(error))] }),
    kind: 'error',
    envrcPath: null,
    stderr,
    exitCode: null,
  }
}

/** `disabledDirs` matched before any IO: the directory injects nothing, and `peek` says so with `{}`. */
export function disabledRecord(dir: string, key: string, stamp: Stamp): DisabledRecord {
  return {
    ...core(dir, key, 'disabled', stamp, { warnings: [] }),
    kind: 'disabled',
    envrcPath: null,
    overlay: {},
    env: {},
  }
}

export interface RunClassification {
  dir: string
  key: string
  base: DirenvBaseEnv
  /** The RC probe, resolved lazily by the caller only once a result actually exists. */
  envrc: EnvrcProbe
  stdout: string
  stderr: string
  exitCode: number | null
  stamp: Stamp
}

export function classifyRun(input: RunClassification): EvaluationRecord {
  const { dir, key, base, stdout, stderr, exitCode, stamp, envrc } = input

  // 1) Non-zero exit: never parse stdout (see this file's header).
  if (exitCode !== 0) return classifyFailure(dir, key, stderr, exitCode, stamp, envrc)

  // 2) Exit 0 with empty stdout: four different sources, disambiguated only by
  //    our own stat — no RC / unreadable RC / `.env`-only with load_dotenv off /
  //    a DIRENV_FILE+DIRENV_WATCHES short circuit (the last one cannot happen
  //    here because every DIRENV_* key is stripped from the base).
  if (stdout.trim() === '') {
    if (!envrc.exists) {
      return { ...core(dir, key, 'absent', stamp, { warnings: [] }), kind: 'absent', envrcPath: null }
    }
    if (!envrc.readable) {
      return {
        ...core(dir, key, 'unreadable', stamp, { envrcPath: envrc.path, warnings: [] }),
        kind: 'unreadable',
        envrcPath: envrc.path,
      }
    }
    const warning = `direnv produced no diff for a readable ${envrc.path} (denied / short-circuit?)`
    return {
      ...core(dir, key, 'absent', stamp, { envrcPath: envrc.path, warnings: [warning] }),
      kind: 'absent',
      envrcPath: envrc.path,
    }
  }

  // 3) Exit 0 with JSON: this is a *diff*, not a full environment.
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    const stderrText = `direnv produced unparseable JSON (${stdout.length} bytes)`
    return badJson(dir, key, stderrText, 'direnv produced unparseable JSON', stamp)
  }
  if (!isJsonObject(parsed)) {
    return badJson(dir, key, 'direnv JSON was not an object', 'direnv JSON was not an object', stamp)
  }

  const overlay: Overlay = {}
  const env: EnvOverlay = {}
  for (const [name, value] of Object.entries(parsed)) {
    // DIRENV_DIFF / DIR / FILE / WATCHES: kept out of the overlay (they are
    // direnv bookkeeping, and replaying them resurrects scrubbed secrets).
    if (DIRENV_KEY.test(name)) continue
    if (value === null) {
      overlay[name] = null
      env[name] = undefined
      continue
    }
    if (typeof value !== 'string') continue
    overlay[name] = value
    env[name] = value
  }

  // Even on exit 0, stderr noise means the overlay is possibly incomplete
  // (`source missing.sh` and syntax errors both exit 0, and variables set before
  // a syntax error are already in effect).
  const warnings = noiseLines(stderr)
  const envrcPath = typeof parsed.DIRENV_FILE === 'string' ? parsed.DIRENV_FILE : envrc.exists ? envrc.path : null
  return {
    ...core(dir, key, 'ok', stamp, { envrcPath, stderr, warnings }),
    kind: 'ok',
    envrcPath,
    overlay,
    env,
    watches: decodeWatches(parsed.DIRENV_WATCHES),
    degraded: warnings.length > 0,
    derived: deriveFacts(overlay, base.PATH),
  } satisfies OkRecord
}

function classifyFailure(
  dir: string,
  key: string,
  stderr: string,
  exitCode: number | null,
  stamp: Stamp,
  envrc: EnvrcProbe,
): EvaluationRecord {
  const errorLines = stderr.match(ERROR_LINE) ?? []
  const blockedLine = errorLines.length === 1 ? errorLines[0] : undefined
  if (blockedLine !== undefined && BLOCKED_LINE.test(blockedLine)) {
    const parsedPath = BLOCKED_PATH.exec(blockedLine)
    const envrcPath = parsedPath ? parsedPath[1] ?? null : envrc.exists ? envrc.path : null
    return {
      ...core(dir, key, 'blocked', stamp, { envrcPath, stderr }),
      kind: 'blocked',
      envrcPath,
      stderr,
    } satisfies BlockedRecord
  }

  const envrcPath = envrc.exists ? envrc.path : null
  const statuses = exitStatuses(errorLines)
  if (statuses.length === 1) {
    const status = statuses[0] ?? 0
    return {
      ...core(dir, key, 'envrc-failed', stamp, { envrcPath, status, stderr }),
      kind: 'envrc-failed',
      envrcPath,
      status,
      stderr,
    } satisfies EnvrcFailedRecord
  }
  if (statuses.length > 1) {
    return {
      ...core(dir, key, 'error', stamp, {
        reason: 'ambiguous-exit-status',
        stderr,
        envrcPath,
        warnings: [`${statuses.length} direnv: error exit status lines in stderr`],
      }),
      kind: 'error',
      envrcPath,
      stderr,
      exitCode,
    }
  }
  if (LOAD_CONFIG.test(stderr)) {
    return {
      ...core(dir, key, 'config-error', stamp, { stderr, envrcPath }),
      kind: 'config-error',
      envrcPath,
      stderr,
    }
  }
  return { ...core(dir, key, 'error', stamp, { stderr, envrcPath }), kind: 'error', envrcPath, stderr, exitCode }
}

function exitStatuses(errorLines: readonly string[]): number[] {
  const codes: number[] = []
  for (const line of errorLines) {
    const match = EXIT_STATUS_LINE.exec(line)
    if (match !== null) codes.push(Number(match[1]))
  }
  return codes
}

function badJson(dir: string, key: string, stderr: string, warning: string, stamp: Stamp): ErrorRecord {
  return {
    ...core(dir, key, 'error', stamp, { stderr, reason: 'bad-json', warnings: [warning] }),
    kind: 'error',
    envrcPath: null,
    stderr,
    exitCode: 0,
  }
}

/**
 * The JSON boundary: direnv's payload is `unknown` until this says otherwise.
 * Arrays are rejected here as well, so the diff loop can never see one.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
