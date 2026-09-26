/**
 * The evaluator's lifecycle and its behaviour under hostile conditions: what a
 * second call may reuse, what happens when direnv hangs, dies, or lies, and how
 * the three-valued `peekEnv` answer drives the spawn path.
 *
 * Fixtures, the real-direnv runner and the isolation strategy live in
 * test/helpers/evaluator-fixtures.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { isRecord } from './helpers/guards.ts'
import {
  allow,
  assertPidGone,
  countingSpawner,
  counterValue,
  DATA_HOME,
  FIXTURES,
  fixture,
  makeEvaluator,
  rawExport,
  readPid,
  scrubbedEnv,
  stderrOf,
  waitForFile,
} from './helpers/evaluator-fixtures.ts'
import type { DirenvBaseEnv, EnvOverlay, OkOutcome } from '../src/types.ts'

/** The object a raw `direnv export json` run printed. */
function rawEnvOf(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout)
  if (!isRecord(parsed)) throw new Error('direnv export json did not answer an object')
  return parsed
}

/** The `DIRENV_*` entries of that object, which are all strings. */
function direnvStateKeys(env: Record<string, unknown>): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('DIRENV_') && typeof value === 'string') keys[key] = value
  }
  return keys
}

/** The watch list inside `DIRENV_WATCHES`, i.e. base64(zlib(JSON)) as direnv writes it. */
function decodeRawWatches(encoded: unknown): { path: string }[] {
  const decoded: unknown = JSON.parse(zlib.inflateSync(Buffer.from(String(encoded), 'base64')).toString('utf8'))
  if (!Array.isArray(decoded)) throw new Error('DIRENV_WATCHES did not decode to a list')
  return decoded.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== 'string') throw new Error('a watch entry carries no path')
    return { path: entry.path }
  })
}

// The security red line: ambient DIRENV_* (e.g. DSH started from a direnv
// shell) must never reach our direnv call, because DIRENV_DIFF's `p` section
// writes scrubbed secrets back by name. Control: raw direnv with the same base
// leaks the secret, the evaluator does not.
test('DIRENV_* pollution cannot resurrect a scrubbed secret', async () => {
  const dirA = fixture('secret-a', { '.envrc': 'export MY_SECRET_TOKEN=from-envrc\nexport A_ONLY=1\n' })
  const dirB = fixture('secret-b', { '.envrc': 'export B_OK=1\n' })
  allow(dirA)
  allow(dirB)

  const rawA = rawExport(dirA, { MY_SECRET_TOKEN: 'the-real-secret' })
  assert.equal(rawA.status, 0, rawA.stderr)
  const parsedA = rawEnvOf(rawA.stdout)
  const direnvKeys = direnvStateKeys(parsedA)
  assert.ok(Object.keys(direnvKeys).length >= 3, 'raw run exposes DIRENV_DIFF/FILE/WATCHES')

  const rawB = rawExport(dirB, direnvKeys)
  assert.equal(rawB.status, 0, rawB.stderr)
  assert.equal(rawEnvOf(rawB.stdout).MY_SECRET_TOKEN, 'the-real-secret', 'the hazard is real without stripping')

  const captured: DirenvBaseEnv[] = []
  const evaluator = makeEvaluator({
    env: direnvKeys,
    deps: {
      spawnDirenv: async (file, args, runOptions) => {
        captured.push(runOptions.env)
        const result = spawnSync(file, args, {
          cwd: runOptions.cwd,
          env: runOptions.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        if (result.error) throw result.error
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
      },
    },
  })
  const outcome = await evaluator.evaluate(dirB)

  assert.equal(captured.length, 1)
  const childEnv = captured[0]!
  assert.ok(!Object.keys(childEnv).some((key) => key.startsWith('DIRENV_')), 'no DIRENV_* reaches direnv')
  assert.equal(childEnv.HOME, os.homedir(), 'HOME is preserved (allow library / nix-direnv)')
  assert.equal(childEnv.XDG_DATA_HOME, DATA_HOME, 'XDG_DATA_HOME is preserved')
  assert.equal(childEnv.PATH, process.env.PATH, 'PATH is preserved')

  assert.equal(outcome.kind, 'ok')
  assert.ok(!('MY_SECRET_TOKEN' in outcome.overlay), 'the secret must not come back through the diff')
  assert.ok(!('MY_SECRET_TOKEN' in outcome.env))
  assert.ok(!JSON.stringify(outcome.env).includes('the-real-secret'))
  assert.deepEqual(outcome.overlay, { B_OK: '1' })
})

// Only direnv's load state may be stripped from the base: `DIRENV_CONFIG` and
// `DIRENV_LOG_FORMAT` are user configuration, and dropping DIRENV_CONFIG makes
// every directory whose allow state lives elsewhere look blocked.
test('base env: DIRENV_CONFIG/DIRENV_LOG_FORMAT/HOME survive, load state does not', async () => {
  const dir = fixture('base-env-filter', { '.envrc': 'export FILTERED=1\n' })
  allow(dir)
  let childEnv: DirenvBaseEnv | null = null
  const evaluator = makeEvaluator({
    deps: {
      baseEnv: () => ({
        DIRENV_CONFIG: '/cfg',
        DIRENV_LOG_FORMAT: '-',
        DIRENV_DIFF: 'blob',
        DIRENV_DIR: '-/x',
        DIRENV_FILE: '/x/.envrc',
        DIRENV_WATCHES: 'blob',
        HOME: '/h',
        PATH: process.env.PATH,
      }),
      spawnDirenv: async (_file, _args, runOptions) => {
        childEnv = runOptions.env
        return { exitCode: 0, stdout: '{}', stderr: '' }
      },
    },
  })
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'ok')
  assert.equal(childEnv!.DIRENV_CONFIG, '/cfg')
  assert.equal(childEnv!.DIRENV_LOG_FORMAT, '-')
  assert.equal(childEnv!.HOME, '/h')
  for (const key of ['DIRENV_DIFF', 'DIRENV_DIR', 'DIRENV_FILE', 'DIRENV_WATCHES']) {
    assert.ok(!(key in childEnv!), `${key} must not reach direnv`)
  }
})

// A scratch `[whitelist] prefix` config approves the RC without writing the
// allow library at all: DIRENV_CONFIG has to reach direnv for it to apply.
test('integration: DIRENV_CONFIG whitelist turns blocked into ok', async () => {
  const dir = fixture('whitelist', { '.envrc': 'export SOME_DIRENV_VAR=direnv-smoke-ok\n' })
  const cfg = path.join(dir, 'cfg')
  fs.mkdirSync(cfg, { recursive: true })
  fs.writeFileSync(path.join(cfg, 'direnv.toml'), `[whitelist]\nprefix = ["${dir}"]\n`)
  const allowDir = path.join(DATA_HOME, 'direnv', 'allow')
  const allowBefore = fs.readdirSync(allowDir).sort().join('\n')

  const withoutConfig = await makeEvaluator().evaluate(dir)
  assert.equal(withoutConfig.kind, 'blocked')

  const outcome = await makeEvaluator({ env: { DIRENV_CONFIG: cfg } }).evaluate(dir)
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.env.SOME_DIRENV_VAR, 'direnv-smoke-ok')
  assert.equal(fs.readdirSync(allowDir).sort().join('\n'), allowBefore, 'the allow library is untouched')
  assert.ok(
    !fs.readdirSync(allowDir).some((entry) => fs.readFileSync(path.join(allowDir, entry), 'utf8').includes(`${dir}/.envrc`)),
    'no allow entry was written for the whitelisted fixture',
  )
})

// Non-zero exits (blocked also prints valid JSON on stdout) must never be
// parsed: a hostile payload has to stay out of the overlay.
test('non-zero exit: stdout is never parsed', async () => {
  const dir = fixture('hostile-stdout', { '.envrc': 'export LEGIT=1\n' })
  allow(dir)
  const base = { baseEnv: () => scrubbedEnv() }

  const failed = makeEvaluator({
    deps: { ...base, spawnDirenv: async () => ({ exitCode: 1, stdout: '{"SMUGGLED":"yes"}', stderr: 'direnv: error exit status 1' }) },
  })
  const failure = await failed.evaluate(dir)
  assert.equal(failure.kind, 'envrc-failed')
  assert.deepEqual(failed.peekEnv(dir), {})

  const blocked = makeEvaluator({
    deps: {
      ...base,
      spawnDirenv: async () => ({
        exitCode: 1,
        stdout: '{"SMUGGLED":"yes"}',
        stderr: `direv: ignorable\ndirenv: error ${dir}/.envrc is blocked. Run \`direnv allow\` to approve its content\n`,
      }),
    },
  })
  const blockedOutcome = await blocked.evaluate(dir)
  assert.equal(blockedOutcome.kind, 'blocked')
  assert.deepEqual(blocked.peekEnv(dir), {})
  assert.ok(!JSON.stringify(blocked.peekEnv(dir)).includes('SMUGGLED'))
})

// Empty JSON object (RC exists, changes nothing) is `ok` with an empty diff —
// not `absent`, which is reserved for empty stdout.
test('empty diff: {} is ok with an empty overlay', async () => {
  const dir = fixture('empty-rc', { '.envrc': ': rc with no exports\n' })
  allow(dir)
  const evaluator = makeEvaluator()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'ok')
  assert.deepEqual(outcome.overlay, {})
  assert.deepEqual(outcome.env, {})
  assert.deepEqual(evaluator.peekEnv(dir), {})
})

// direnv has no cross-process cache: a memo hit is the only thing that can stop
// `ensureEnv` from spawning, and `memo: false` must disable it entirely.
test('memo:false really re-runs, peekEnv stays empty', async () => {
  const dir = fixture('memo-off', { '.envrc': 'echo run >> counter.txt\nexport MEMO_OFF=1\n' })
  allow(dir)
  const evaluator = makeEvaluator({ memo: false })

  assert.equal((await evaluator.evaluate(dir)).kind, 'ok')
  assert.equal(((await evaluator.evaluate(dir)) as OkOutcome).memoHit, false)
  assert.equal(counterValue(dir), 2)
  assert.equal(evaluator.peekEnv(dir), undefined)
})

// invalidate() must drop the record; the next call re-runs the RC.
test('invalidate: per-directory and global', async () => {
  const dir = fixture('invalidate', { '.envrc': 'echo run >> counter.txt\nexport INV=1\n' })
  allow(dir)
  const evaluator = makeEvaluator()

  await evaluator.evaluate(dir)
  await evaluator.evaluate(dir)
  assert.equal(counterValue(dir), 1)

  evaluator.invalidate(dir)
  assert.equal(evaluator.status(dir).state, 'idle')
  assert.equal(evaluator.peekEnv(dir), undefined)
  await evaluator.evaluate(dir)
  assert.equal(counterValue(dir), 2)

  evaluator.invalidate()
  assert.equal(evaluator.status(dir).state, 'idle')
})

// Same directory, concurrent callers: exactly one direnv process, and the
// in-flight directory is visible to the sidebar.
test('in-flight dedup: concurrent evaluate shares one run', async () => {
  const dir = fixture('dedup', { '.envrc': 'echo run >> counter.txt\nsleep 0.4\nexport DEDUP=1\n' })
  allow(dir)
  const evaluator = makeEvaluator()

  const first = evaluator.evaluate(dir)
  const second = evaluator.evaluate(dir)
  assert.ok(evaluator.inFlight().includes(dir), 'the directory is reported in flight')
  const [a, b] = await Promise.all([first, second])

  assert.equal(a.kind, 'ok')
  assert.equal(b.kind, 'ok')
  assert.equal(counterValue(dir), 1, 'only one direnv process ran')
  assert.deepEqual(evaluator.inFlight(), [])
})

// The other half of the same guarantee: prewarm is what `spawn()` fires on every
// subprocess of an unknown directory, so N concurrent prewarms must still share
// one evaluation — and, under the "never kill" default, one child per directory.
test('in-flight dedup: concurrent prewarm spawns a single direnv', async () => {
  const dir = fixture('dedup-prewarm', { '.envrc': 'echo run >> counter.txt\nsleep 0.4\nexport DEDUP_PREWARM=1\n' })
  allow(dir)
  const counter = countingSpawner()
  const evaluator = makeEvaluator({ evaluateTimeoutMs: 0, deps: { spawnDirenv: counter.spawnDirenv } })

  await Promise.all([evaluator.prewarm(dir), evaluator.prewarm(dir), evaluator.prewarm(dir), evaluator.prewarm(dir)])

  assert.equal(counter.count, 1, 'four concurrent prewarms, one direnv process')
  assert.equal(counterValue(dir), 1)
  assert.deepEqual(evaluator.peekEnv(dir), { DEDUP_PREWARM: '1' })
  assert.deepEqual(evaluator.inFlight(), [])
})

// A determinate conclusion is final: `peekEnv` stays `{}`, and repeated prewarms
// must not restart direnv for it.
test('determinate: blocked and absent keep peekEnv at {} and never re-spawn', async () => {
  const blockedDir = fixture('determinate-blocked', { '.envrc': 'export SHOULD_NOT_LEAK=1\n' })
  const absentDir = fixture('determinate-absent', { 'README.md': 'no rc here\n' })
  const counter = countingSpawner()
  const evaluator = makeEvaluator({ deps: { spawnDirenv: counter.spawnDirenv } })

  assert.equal((await evaluator.evaluate(blockedDir)).kind, 'blocked')
  assert.equal((await evaluator.evaluate(absentDir)).kind, 'absent')
  assert.equal(counter.count, 2)

  for (let i = 0; i < 3; i += 1) {
    await evaluator.prewarm(blockedDir)
    await evaluator.prewarm(absentDir)
  }
  assert.deepEqual(evaluator.peekEnv(blockedDir), {})
  assert.deepEqual(evaluator.peekEnv(absentDir), {})
  assert.equal(counter.count, 2, 'no direnv process per subprocess for a determinate conclusion')
})

// isDirDisabled short-circuits before spawning, and a config flip takes effect
// on the very next call (no restart, no invalidate).
test('disabled: isDirDisabled skips direnv entirely', async () => {
  const dir = fixture('disabled', { '.envrc': 'export DISABLED_DIR=1\n' })
  allow(dir)
  let spawned = 0
  let disabled = true
  const evaluator = makeEvaluator({
    isDirDisabled: (candidate) => disabled && candidate === dir,
    deps: {
      spawnDirenv: async () => {
        spawned += 1
        return { exitCode: 0, stdout: '{}', stderr: '' }
      },
    },
  })

  const outcome = await evaluator.evaluate(dir)
  assert.equal(outcome.kind, 'disabled')
  assert.equal(outcome.at > 0, true)
  assert.equal(spawned, 0)
  assert.deepEqual(evaluator.peekEnv(dir), {})
  assert.equal(evaluator.status(dir).state, 'disabled')

  disabled = false
  const enabled = await evaluator.evaluate(dir)
  assert.equal(enabled.kind, 'ok')
  assert.equal(spawned, 1)
})

// Path additions are reported relative to the base PATH (they are what the
// sidebar shows as "direnv changed PATH").
test('status: path additions relative to base PATH', async () => {
  const dir = fixture('path-add', { '.envrc': 'export PATH="$PWD/bin:$PATH"\n' })
  fs.mkdirSync(path.join(dir, 'bin'))
  allow(dir)
  const evaluator = makeEvaluator()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.overlay.PATH, `${path.join(dir, 'bin')}:${process.env.PATH}`)
  const status = evaluator.status(dir)
  assert.deepEqual(status.pathAdditions, [path.join(dir, 'bin')])
  assert.equal(status.variables.find((entry) => entry.name === 'PATH')!.sensitive, false)
})

// `direnv` is missing / the cwd does not exist: Node reports ENOENT for both
// with err.path pointing at direnv, so the stat has to disambiguate.
test('direnv-unavailable: ENOENT from spawn, missing cwd, cwd is a file', async () => {
  const dir = fixture('unavailable', { '.envrc': 'export NOPE=1\n' })
  allow(dir)

  let calls = 0
  const enoent = makeEvaluator({
    deps: {
      spawnDirenv: async () => {
        calls += 1
        throw Object.assign(new Error('spawn direnv ENOENT'), { code: 'ENOENT' })
      },
    },
  })
  const spawnFailure = await enoent.evaluate(dir)
  assert.equal(spawnFailure.kind, 'direnv-unavailable')
  assert.equal(spawnFailure.code, 'ENOENT')
  assert.equal(spawnFailure.reason, 'spawn ENOENT')
  assert.deepEqual(enoent.peekEnv(dir), {})

  // transient failures are never reused as a hit
  await enoent.evaluate(dir)
  assert.equal(calls, 2)

  const missing = await makeEvaluator().evaluate(path.join(FIXTURES, 'does-not-exist'))
  assert.equal(missing.kind, 'direnv-unavailable')
  assert.equal(missing.code, 'ENOENT')
  assert.equal(missing.reason, 'cwd-missing')

  const asFile = await makeEvaluator({
    deps: {
      spawnDirenv: async () => {
        throw new Error('spawn must not be reached for a non-directory cwd')
      },
    },
  }).evaluate(path.join(dir, '.envrc'))
  assert.equal(asFile.kind, 'direnv-unavailable')
  assert.equal(asFile.code, 'ENOTDIR')
  assert.equal(asFile.reason, 'cwd-not-a-directory')
})

// Unparseable stdout on exit 0 is mapped onto `error`/bad-json, never thrown.
test('bad-json: unparseable stdout never throws', async () => {
  const dir = fixture('bad-json', { '.envrc': 'export X=1\n' })
  allow(dir)
  const evaluator = makeEvaluator({
    deps: { spawnDirenv: async () => ({ exitCode: 0, stdout: '{not json', stderr: '' }) },
  })
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.reason, 'bad-json')
  assert.equal(outcome.exitCode, 0)
  // `error` is the transient bucket whatever its reason: the next spawn may get
  // parseable JSON, so the directory must not be written off as "nothing here".
  assert.equal(evaluator.peekEnv(dir), undefined)
})

// evaluateTimeoutMs is a hard cap on the evaluation child: a hanging RC becomes
// `error`/timeout, not a hang — and that record is transient, so the directory
// is retried instead of being written off.
test('timeout: slow .envrc is cut off and stays retryable', async () => {
  const dir = fixture('timeout', { '.envrc': 'export SLOW=1\nsleep 20\n' })
  allow(dir)
  const evaluator = makeEvaluator({ evaluateTimeoutMs: 400 })
  const started = Date.now()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.reason, 'timeout')
  assert.match(outcome.stderr, /did not finish within 400ms/)
  assert.ok(Date.now() - started < 10000, 'the run was actually killed')
  assert.equal(evaluator.peekEnv(dir), undefined, 'a killed run is unknown, not "empty environment"')
})

// Killing `direnv` alone orphans the bash it sources the RC in and anything
// that bash started. `detached` + a negative-pid SIGKILL has to take the whole
// group down, while the Promise still settles on its 50ms deadline.
test('timeout: the whole process group dies with direnv', async () => {
  const dir = fixture('timeout-group', {
    '.envrc': 'echo $$ > rc.pid\nsleep 987 & echo $! > sleeper.pid\nwait\n',
  })
  allow(dir)
  const evaluator = makeEvaluator({ evaluateTimeoutMs: 400 })
  const started = Date.now()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.reason, 'timeout')
  assert.ok(Date.now() - started < 5000, 'the timeout path still settles promptly')

  await assertPidGone(readPid(dir, 'rc.pid'), 'the .envrc bash')
  await assertPidGone(readPid(dir, 'sleeper.pid'), 'the sleep the RC started')
})

// A transient failure must not poison the directory: `peekEnv` reports it as
// unknown (which is what makes `spawn()` prewarm again), and the next prewarm
// really re-runs direnv on the same memo key.
test('transient timeout: peekEnv is undefined and the next prewarm re-runs', async () => {
  const dir = fixture('transient-timeout', {
    '.envrc': 'echo run >> counter.txt\nif [ -f slow ]; then sleep 10; fi\nexport AFTER_TIMEOUT=yes\n',
  })
  allow(dir)
  fs.writeFileSync(path.join(dir, 'slow'), '')
  const evaluator = makeEvaluator({ evaluateTimeoutMs: 400 })

  const first = await evaluator.evaluate(dir)
  assert.equal(first.kind, 'error')
  assert.equal(first.reason, 'timeout')
  assert.equal(evaluator.peekEnv(dir), undefined)
  assert.equal(counterValue(dir), 1)

  fs.rmSync(path.join(dir, 'slow'))
  await evaluator.prewarm(dir)
  assert.deepEqual(evaluator.peekEnv(dir), { AFTER_TIMEOUT: 'yes' })
  assert.equal(counterValue(dir), 2, 'the retry really ran the RC again')
})

// The generic spawn-failure branch is transient too. `direnv-unavailable`
// (missing binary / missing cwd) is not: retrying cannot change it, so it stays
// in the determinate bucket and `peekEnv` returns `{}`.
test('transient spawn failure: peekEnv is undefined and the next prewarm succeeds', async () => {
  const dir = fixture('transient-spawn', { '.envrc': ': spawn is injected\n' })
  allow(dir)
  let calls = 0
  const evaluator = makeEvaluator({
    deps: {
      spawnDirenv: async () => {
        calls += 1
        if (calls === 1) {
          throw Object.assign(new Error('spawn direnv E2BIG'), { code: 'E2BIG' })
        }
        return { exitCode: 0, stdout: '{"SPAWN_RETRIED":"yes"}', stderr: '' }
      },
    },
  })

  const first = await evaluator.evaluate(dir)
  assert.equal(first.kind, 'error')
  assert.equal(first.reason, 'spawn-failed')
  assert.equal(evaluator.peekEnv(dir), undefined)

  await evaluator.prewarm(dir)
  assert.deepEqual(evaluator.peekEnv(dir), { SPAWN_RETRIED: 'yes' })
  assert.equal(calls, 2)
})

// AbortSignal: an already-aborted signal does nothing, and aborting mid-run
// leaves no record behind (an aborted run says nothing about the directory) —
// and, like the timeout, no orphaned RC bash or grandchild either.
test('abort: pre-aborted and mid-run signals', async () => {
  const dir = fixture('abort', {
    '.envrc': 'export ABORTED_DIR=1\necho $$ > rc.pid\nsleep 987 & echo $! > sleeper.pid\nwait\n',
  })
  allow(dir)
  const evaluator = makeEvaluator({ evaluateTimeoutMs: 30000 })

  const pre = new AbortController()
  pre.abort()
  const preOutcome = await evaluator.evaluate(dir, { signal: pre.signal })
  assert.equal(preOutcome.kind, 'error')
  assert.equal(preOutcome.reason, 'aborted')
  assert.equal(evaluator.status(dir).state, 'idle')
  assert.ok(!fs.existsSync(path.join(dir, 'rc.pid')), 'a pre-aborted signal never spawned direnv')

  const mid = new AbortController()
  const pending = evaluator.evaluate(dir, { signal: mid.signal })
  await waitForFile(path.join(dir, 'sleeper.pid'))
  mid.abort()
  const midOutcome = await pending
  assert.equal(midOutcome.kind, 'error')
  assert.equal(midOutcome.reason, 'aborted')
  assert.equal(evaluator.status(dir).state, 'idle', 'aborted runs are not recorded')

  await assertPidGone(readPid(dir, 'rc.pid'), 'the aborted .envrc bash')
  await assertPidGone(readPid(dir, 'sleeper.pid'), 'the sleep the aborted RC started')
})

// prewarm() is fire-and-forget: it must never reject, even for broken input.
test('prewarm: never rejects and populates peekEnv', async () => {
  const dir = fixture('prewarm', { '.envrc': 'export PREWARMED=1\n' })
  allow(dir)
  const evaluator = makeEvaluator()

  await evaluator.prewarm(dir)
  assert.deepEqual(evaluator.peekEnv(dir), { PREWARMED: '1' })

  await evaluator.prewarm(path.join(FIXTURES, 'missing-dir'))
  await makeEvaluator({
    deps: {
      spawnDirenv: async () => {
        throw new Error('boom')
      },
    },
  }).prewarm(dir)
})

// The sidebar reload button goes through prewarm(dir, { force: true }): the
// option has to reach ensureEnv or the reload silently reads the stale memo.
test('prewarm: force re-runs the RC even on a memo hit', async () => {
  const dir = fixture('prewarm-force', { '.envrc': 'echo run >> counter.txt\nexport PREWARM_FORCE=1\n' })
  allow(dir)
  const evaluator = makeEvaluator()

  await evaluator.prewarm(dir)
  assert.equal(counterValue(dir), 1)
  await evaluator.prewarm(dir)
  assert.equal(counterValue(dir), 1, 'memo hit')

  await evaluator.prewarm(dir, { force: true })
  assert.equal(counterValue(dir), 2, 'force really re-runs direnv')
})

// stdin must be `ignore`: a `read` in the RC has to see EOF instantly instead
// of blocking on the harness' stdin.
test('stdin is ignored: read gets EOF immediately', async () => {
  const dir = fixture('stdin-ignore', { '.envrc': 'read -r LINE\nexport STDIN_LINE="${LINE:-eof}"\n' })
  allow(dir)
  const evaluator = makeEvaluator({ evaluateTimeoutMs: 3000 })
  const started = Date.now()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.overlay.STDIN_LINE, 'eof')
  assert.ok(Date.now() - started < 2000, 'no blocking read')
})

// Real dev shells emit ~10-15 KB but the collector must survive 1 MB. A single
// 1 MB variable cannot be exported at all (MAX_ARG_STRLEN -> E2BIG inside
// direnv), so the volume is spread over 20 variables of 55 KB.
test('large output: 1 MB of overlay survives', async () => {
  const dir = fixture('large-output', {
    '.envrc': [
      'i=0',
      'while [ $i -lt 20 ]; do',
      '  i=$((i + 1))',
      '  export "BIG_$i=$(head -c 55000 /dev/zero | tr \'\\0\' \'x\')"',
      'done',
      '',
    ].join('\n'),
  })
  allow(dir)
  const outcome = await makeEvaluator().evaluate(dir)

  assert.equal(outcome.kind, 'ok')
  const big = Object.entries(outcome.overlay).filter(([name]) => name.startsWith('BIG_'))
  assert.equal(big.length, 20)
  assert.ok(big.reduce((total, [, value]) => total + value!.length, 0) > 1000000, 'over 1 MB collected')
})

// `evaluate` is documented as never throwing: even a deps function that
// rejects outright must come back as the specific Outcome the failure maps to.
// Here `stat` explodes (so cwd probing is inconclusive, not ENOENT) and the
// spawn itself throws a plain Error with no code, which is the generic
// transient `spawn-failed` bucket — not an `absent` guess and not a throw.
test('evaluate never throws for hostile deps', async () => {
  const dir = fixture('hostile-deps', { '.envrc': 'export X=1\n' })
  allow(dir)
  const evaluator = makeEvaluator({
    deps: {
      stat: async () => {
        throw new Error('stat exploded')
      },
      spawnDirenv: async () => {
        throw new Error('spawn exploded')
      },
    },
  })
  const outcome = await evaluator.evaluate(dir)
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.reason, 'spawn-failed')
  assert.match(outcome.stderr, /spawn exploded/)
  assert.equal(evaluator.status(dir).state, 'error')
  assert.equal(evaluator.peekEnv(dir), undefined, 'a failed spawn is unknown, not an empty environment')
})

// `peekEnv` is called on the hot spawn path and its result is handed to the
// caller: it must be a copy, so nothing downstream can corrupt the record (or
// leak a mutation into the next spawn through it).
test('peekEnv: the returned object is a copy, not the record', async () => {
  const dir = fixture('peek-copy', { '.envrc': 'export COPY_ME=original\n' })
  allow(dir)
  const evaluator = makeEvaluator()
  assert.equal((await evaluator.evaluate(dir)).kind, 'ok')

  // The three-valued answer is narrowed to the injectable one here on purpose:
  // the mutation below is what proves the record was copied.
  const leaked = evaluator.peekEnv(dir) as EnvOverlay
  leaked.COPY_ME = 'mutated'
  leaked.EXTRA = 'injected'

  assert.deepEqual(evaluator.peekEnv(dir), { COPY_ME: 'original' })
  assert.deepEqual(await evaluator.ensureEnv(dir), { COPY_ME: 'original' })
  assert.equal(evaluator.status(dir).env!.COPY_ME, 'original')
})

// Optional read-only check against a real workspace. Skipped by default: even a
// hot `use nix` / `use flake` run rewrites the project's `.direnv/` cache, and
// the workspace red line forbids writing there from this test suite. The
// nix-direnv *shape* it would cover is reproduced hermetically by the fixture
// test above, so nothing depends on this one being run.
test(
  'real workspace (opt-in): a nix-direnv workspace outside this repository',
  { skip: process.env.DIRENV_EVAL_REAL_DIR === undefined },
  async () => {
  const dir = process.env.DIRENV_EVAL_REAL_DIR ?? ''
  if (!fs.existsSync(path.join(dir, '.envrc')) || !fs.existsSync(path.join(dir, '.direnv'))) {
    test.skip('no .direnv cache present')
    return
  }
  const outcome = await makeEvaluator({ evaluateTimeoutMs: 120000 }).evaluate(dir)
  assert.ok(['ok', 'blocked', 'unreadable'].includes(outcome.kind), `unexpected ${outcome.kind}: ${stderrOf(outcome)}`)
  if (outcome.kind === 'ok') {
    assert.ok(Object.keys(outcome.overlay).length > 0)
    assert.ok(evaluatorPathAdditions(outcome).length > 0)
  }
})

function evaluatorPathAdditions(outcome: OkOutcome): string[] {
  const value = outcome.overlay?.PATH
  if (typeof value !== 'string') return []
  const known = new Set(String(process.env.PATH ?? '').split(':').filter(Boolean))
  return value.split(':').filter((entry) => entry && !known.has(entry))
}

// DIRENV_WATCHES decoding sanity: the raw encoding is base64(zlib(JSON)).
test('watches decoding matches the raw direnv payload', async () => {
  const dir = fixture('watches-raw', { '.envrc': 'watch_file ./a.txt\nwatch_file ./b.txt\n', 'a.txt': 'a\n', 'b.txt': 'b\n' })
  allow(dir)
  const raw = rawExport(dir)
  const rawWatches = decodeRawWatches(rawEnvOf(raw.stdout).DIRENV_WATCHES)
  const outcome = (await makeEvaluator().evaluate(dir)) as OkOutcome

  assert.deepEqual(
    outcome.watches!.map((watch) => watch.path).sort(),
    rawWatches.map((watch) => watch.path).sort(),
  )
  assert.equal(outcome.watches!.find((watch) => watch.path === path.join(dir, 'b.txt'))!.exists, true)
})
