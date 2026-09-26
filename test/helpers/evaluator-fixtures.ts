/**
 * Shared fixtures for the evaluator tests — every case runs the *real* direnv
 * (2.37.1) against a fixture built under `/tmp/direnv-impl`.
 *
 * Isolation strategy: `XDG_DATA_HOME` points at a throwaway copy of the real
 * allow/deny library, so `direnv allow` inside tests writes only under /tmp
 * (the host library is never touched) while the real workspaces keep their
 * allow state. `HOME` / `XDG_CONFIG_HOME` stay real on purpose: isolating them
 * turns every directory into "blocked" and would hide the real config path
 * (`~/.config/direnv/lib/hm-nix-direnv.sh`).
 *
 * `deps` injection is used only for paths real direnv cannot produce on demand
 * (ENOENT/EACCES/ENOTDIR, hostile stdout, pre-aborted signals).
 */

import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

import { createEvaluator } from '../../src/evaluator/index.ts'
import type {
  AmbientEnv,
  Evaluator,
  EvaluatorDepsInput,
  LogFn,
  Outcome,
  SpawnDirenvFn,
} from '../../src/types.ts'

const TMP = '/tmp/direnv-impl'
// Per-process paths: a second concurrent run of this file must not share
// fixtures (or its `direnv allow` writes) with this one.
const FIXTURES = path.join(TMP, `fixtures-${process.pid}`)
const DATA_HOME = path.join(TMP, `xdg-data-${process.pid}`)
const REAL_DATA = path.join(os.homedir(), '.local', 'share', 'direnv')

export { TMP, FIXTURES, DATA_HOME }

/**
 * Read a field off the outcome the evaluator really produced. `Outcome` is a
 * discriminated union, so a field belongs to the kinds that carry it — and two
 * cases here read one (or assert one is absent) before the kind is narrowed.
 */
export function probeField(outcome: Outcome, key: string): unknown {
  return Reflect.get(outcome, key)
}

/** The `stderr` a run really produced, for the reads that precede the kind narrowing. */
export function stderrOf(outcome: Outcome): string {
  const value = probeField(outcome, 'stderr')
  return typeof value === 'string' ? value : ''
}

/** Drop run directories whose owning process is gone. */
function cleanupStaleRuns(): void {
  fs.mkdirSync(TMP, { recursive: true })
  for (const entry of fs.readdirSync(TMP)) {
    const match = /^(fixtures|xdg-data)-(\d+)$/.exec(entry)
    if (!match) continue
    const owner = Number(match[2])
    let alive = owner === process.pid
    if (!alive) {
      try {
        process.kill(owner, 0)
        alive = true
      } catch {
        alive = false
      }
    }
    if (!alive) fs.rmSync(path.join(TMP, entry), { recursive: true, force: true })
  }
}
cleanupStaleRuns()

/** Fresh copy of the real allow/deny library: host state preserved, fixtures unallowed. */
function resetDataHome(): void {
  fs.rmSync(path.join(DATA_HOME, 'direnv'), { recursive: true, force: true })
  for (const sub of ['allow', 'deny']) {
    const from = path.join(REAL_DATA, sub)
    const to = path.join(DATA_HOME, 'direnv', sub)
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true })
    else fs.mkdirSync(to, { recursive: true })
  }
}
resetDataHome()
fs.rmSync(FIXTURES, { recursive: true, force: true })

/** Ambient environment the evaluator should see, minus credentials and DIRENV_*. */
export function scrubbedEnv(extra: Record<string, string | undefined> = {}): AmbientEnv {
  const env: AmbientEnv = { ...process.env, XDG_DATA_HOME: DATA_HOME }
  for (const key of Object.keys(env)) {
    if (/^DIRENV_/.test(key) || /KEY|PASSWORD|SECRET|TOKEN/i.test(key) || /^DSH_/i.test(key)) delete env[key]
  }
  return { ...env, ...extra }
}

export interface MakeEvaluatorOptions {
  memo?: boolean
  evaluateTimeoutMs?: number
  env?: Record<string, string | undefined>
  deps?: EvaluatorDepsInput
  isDirDisabled?: ((dir: string) => boolean) | undefined
  log?: LogFn | undefined
}

export function makeEvaluator({
  memo = true,
  evaluateTimeoutMs = 30000,
  env = {},
  deps = {},
  isDirDisabled,
  log,
}: MakeEvaluatorOptions = {}): Evaluator {
  return createEvaluator({
    memo,
    evaluateTimeoutMs,
    isDirDisabled,
    log: log ?? (() => {}),
    deps: { baseEnv: () => scrubbedEnv(env), ...deps },
  })
}

/** Build a fixture directory; contents are rewritten from scratch on every run. */
export function fixture(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(FIXTURES, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return dir
}

function assertFixturePath(dir: string): void {
  assert.ok(dir.startsWith(`${TMP}${path.sep}`), `refusing to run direnv outside ${TMP}: ${dir}`)
}

/** Real direnv, never mocked; only ever pointed at /tmp fixtures. */
export function runDirenv(
  args: readonly string[],
  dir: string,
  env: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  assertFixturePath(dir)
  return spawnSync('direnv', args, {
    cwd: dir,
    env: scrubbedEnv(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  })
}

export function allow(dir: string, env: Record<string, string | undefined> = {}): void {
  const result = runDirenv(['allow', '.'], dir, env)
  assert.equal(result.status, 0, `direnv allow failed: ${result.stderr}`)
}

export function rawExport(dir: string, extraEnv?: Record<string, string | undefined>): SpawnSyncReturns<string> {
  return runDirenv(['export', 'json'], dir, extraEnv)
}

export function counterValue(dir: string): number {
  const file = path.join(dir, 'counter.txt')
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').length
}

/**
 * A whole-millisecond timestamp, so a later `utimesSync` can restore a file's
 * mtime *exactly*: that is what makes "same size AND same mtime" reproducible
 * on filesystems that keep sub-millisecond precision.
 */
const PINNED_MTIME = new Date(1700000000000)

export function pinMtime(target: string): void {
  fs.utimesSync(target, PINNED_MTIME, PINNED_MTIME)
}

/** Rewrite a file in place with different content of the same byte length and
 *  the mtime restored; asserts the adversary premise actually holds. `pinMtime`
 *  first when the restored mtime has to be exact to the millisecond. */
export function rewriteInPlace(target: string, content: string): void {
  const before = fs.statSync(target)
  assert.equal(Buffer.byteLength(content), before.size, `${target}: fixture must keep the size`)
  fs.writeFileSync(target, content)
  fs.utimesSync(target, before.atime, before.mtime)
  const after = fs.statSync(target)
  assert.equal(after.size, before.size, `${target}: size must be unchanged`)
  assert.equal(after.mtimeMs, before.mtimeMs, `${target}: mtime must be unchanged`)
}

export function readPid(dir: string, name: string): number {
  const pid = Number(fs.readFileSync(path.join(dir, name), 'utf8').trim())
  assert.ok(Number.isInteger(pid) && pid > 1, `${name} must hold a pid, got ${pid}`)
  return pid
}

/** Errors crossing a process boundary are `unknown`; the errno code is the one field this suite reads. */
function errnoCode(error: unknown): string | undefined {
  const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
  return typeof code === 'string' ? code : undefined
}

/** Killed processes are reaped asynchronously, so poll for the pid to vanish. */
export async function assertPidGone(pid: number, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (errnoCode(error) === 'ESRCH') return
      throw error
    }
    if (Date.now() > deadline) assert.fail(`${label} (pid ${pid}) is still alive`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export async function waitForFile(target: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(target)) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${target}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export interface CountingSpawner {
  count: number
  spawnDirenv: SpawnDirenvFn
}

/**
 * Real direnv behind a counter: proves how many processes an evaluator really
 * started, which is what "do not re-run on every subprocess" means.
 */
export function countingSpawner(): CountingSpawner {
  const state: CountingSpawner = {
    count: 0,
    spawnDirenv: async (file, args, runOptions) => {
      state.count += 1
      const result = spawnSync(file, args, {
        cwd: runOptions.cwd,
        env: runOptions.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (result.error) throw result.error
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
    },
  }
  return state
}
