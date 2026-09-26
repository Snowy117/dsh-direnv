/**
 * How every shape a real direnv run can produce is classified: `absent` / `ok` /
 * `blocked` / `envrc-failed` / `config-error` / `unreadable`, plus the forged
 * stderr lines that must not move a run between those verdicts.
 *
 * The fixtures, the real-direnv runner and the isolation strategy live in
 * test/helpers/evaluator-fixtures.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { allow, DATA_HOME, FIXTURES, fixture, makeEvaluator, probeField, stderrOf } from './helpers/evaluator-fixtures.ts'

// No `.envrc` at all: direnv exits 0 with empty stdout, which must come back as
// `absent` — and must still leave a record so `peekEnv` stops prewarming.
test('absent: directory without .envrc', async () => {
  const dir = fixture('absent', { 'README.md': 'nothing here\n' })
  const evaluator = makeEvaluator()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'absent')
  assert.equal(outcome.dir, dir)
  assert.ok(Number.isFinite(outcome.ms) && outcome.ms >= 0)
  assert.ok(Number.isFinite(outcome.at))

  assert.deepEqual(evaluator.peekEnv(dir), {})
  assert.deepEqual(await evaluator.ensureEnv(dir), {})

  const status = evaluator.status(dir)
  assert.equal(status.state, 'absent')
  assert.equal(status.env, null)
  assert.deepEqual(status.variables, [])
  assert.equal(status.errorSummary, null)
  assert.equal(evaluator.status(path.join(FIXTURES, 'never-evaluated')).state, 'idle')
})

// Ordinary RC: values land in overlay/env, stderr chatter stays out of warnings.
test('ok: plain .envrc sets variables, watches decode', async () => {
  const dir = fixture('ok-basic', {
    '.envrc': 'export FOO=bar\nexport SECRET_TOKEN=s3cret\nwatch_file ./watched.txt\n',
    'watched.txt': 'watched\n',
  })
  allow(dir)
  const evaluator = makeEvaluator()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.envrcPath, path.join(dir, '.envrc'))
  assert.deepEqual(outcome.overlay, { FOO: 'bar', SECRET_TOKEN: 's3cret' })
  assert.deepEqual(outcome.env, { FOO: 'bar', SECRET_TOKEN: 's3cret' })
  assert.equal(outcome.degraded, false)
  assert.deepEqual(outcome.warnings, [])
  assert.equal(outcome.memoHit, false)

  // DIRENV_WATCHES is base64+zlib of {path,modtime,exists}[]: the RC, the
  // allow/deny entries and every watch_file target must all be there.
  assert.ok(Array.isArray(outcome.watches))
  const byPath = new Map(outcome.watches.map((watch) => [watch.path, watch]))
  const rc = byPath.get(path.join(dir, '.envrc'))
  assert.ok(rc, 'the RC itself is watched')
  assert.equal(rc.exists, true)
  assert.ok(rc.modtime > 0 && rc.modtime < 1e11, 'watches modtime is seconds, not ms')
  assert.equal(byPath.get(path.join(dir, 'watched.txt'))?.exists, true)
  assert.ok(
    outcome.watches.some((watch) => watch.path.startsWith(path.join(DATA_HOME, 'direnv', 'allow'))),
    'the allow entry is watched',
  )
  for (const watch of outcome.watches) {
    assert.deepEqual(Object.keys(watch).sort(), ['exists', 'modtime', 'path'])
  }

  assert.deepEqual(evaluator.peekEnv(dir), { FOO: 'bar', SECRET_TOKEN: 's3cret' })
  assert.deepEqual(await evaluator.ensureEnv(dir), { FOO: 'bar', SECRET_TOKEN: 's3cret' })

  const status = evaluator.status(dir)
  assert.equal(status.state, 'ok')
  assert.deepEqual(status.credentials, ['SECRET_TOKEN'])
  assert.deepEqual(
    status.variables,
    [
      { name: 'FOO', sensitive: false, hasValue: true },
      { name: 'SECRET_TOKEN', sensitive: true, hasValue: true },
    ],
  )
  assert.equal(status.memoHit, true) // the ensureEnv above reused the record
})

// `unset FOO` is a tombstone only when FOO exists in the inherited env; when it
// does not, direnv omits the key entirely and the variable must stay untouched.
test('unset: tombstone when inherited, key-omitted when not', async () => {
  const dir = fixture('unset', { '.envrc': 'unset INHERITED\nexport KEPT=1\n' })
  allow(dir)

  const withVariable = makeEvaluator({ env: { INHERITED: 'from-base' } })
  const a = await withVariable.evaluate(dir)
  assert.equal(a.kind, 'ok')
  assert.equal(a.overlay.INHERITED, null)
  assert.equal(a.env.INHERITED, undefined)
  assert.ok('INHERITED' in a.env, 'tombstone keeps the key with an undefined value')
  assert.equal(a.overlay.KEPT, '1')

  const withoutVariable = makeEvaluator()
  const b = await withoutVariable.evaluate(dir)
  assert.equal(b.kind, 'ok')
  assert.ok(!('INHERITED' in b.overlay), 'absent-from-base unset produces no key')
  assert.equal(b.overlay.KEPT, '1')
})

// `exit N` inside the RC keeps direnv's exit code at 1; the real status only
// exists in the stderr text, and that RC's exports are all discarded.
test('envrc-failed: exit 7 in .envrc', async () => {
  const dir = fixture('exit-7', { '.envrc': 'export BEFORE_EXIT=yes\nexit 7\nexport AFTER_EXIT=no\n' })
  allow(dir)
  const evaluator = makeEvaluator()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'envrc-failed')
  assert.equal(outcome.status, 7)
  assert.match(outcome.stderr, /direnv: error exit status 7/)
  assert.ok(!('overlay' in outcome), 'a failed RC never yields an injectable overlay')
  assert.deepEqual(evaluator.peekEnv(dir), {})
  assert.equal(evaluator.status(dir).errorSummary, 'exit status 7')
})

// A real bash syntax error exits 0, still exports what ran before it, and only
// shows up as stderr noise → `ok` + degraded.
test('syntax error: exit 0 with partial overlay and degraded', async () => {
  const dir = fixture('syntax-error', {
    '.envrc': 'export SYNTAX_BEFORE=yes\nif true; then\n  echo ok\n',
  })
  allow(dir)
  const evaluator = makeEvaluator()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.overlay.SYNTAX_BEFORE, 'yes')
  assert.ok(!('SYNTAX_AFTER' in outcome.overlay))
  assert.equal(outcome.degraded, true)
  assert.ok(outcome.warnings.some((line) => /syntax error/.test(line)), outcome.warnings.join('|'))
  assert.equal(evaluator.status(dir).warnings.length >= 1, true)
})

// `source ./missing.sh` also exits 0: the variables before AND after it are in
// the overlay, and the bash error becomes a warning.
test('source missing file: exit 0, degraded, later variables still applied', async () => {
  const dir = fixture('source-missing', {
    '.envrc': 'export SRC_BEFORE=yes\nsource ./does-not-exist.sh\nexport SRC_AFTER=no\n',
  })
  allow(dir)
  const outcome = await makeEvaluator().evaluate(dir)

  assert.equal(outcome.kind, 'ok')
  assert.deepEqual(outcome.overlay, { SRC_BEFORE: 'yes', SRC_AFTER: 'no' })
  assert.equal(outcome.degraded, true)
  assert.ok(outcome.warnings.some((line) => /No such file/.test(line)), outcome.warnings.join('|'))
})

// chmod 000 on an allowed RC: direnv exits 0 with empty stdout and emits no
// tombstone, so only our own stat can tell it apart from `absent`.
test('unreadable: chmod 000 on the .envrc', async () => {
  const dir = fixture('chmod-000', { '.envrc': 'export CHMODDED=1\n' })
  allow(dir)
  fs.chmodSync(path.join(dir, '.envrc'), 0o000)
  try {
    const evaluator = makeEvaluator()
    const outcome = await evaluator.evaluate(dir)
    assert.equal(outcome.kind, 'unreadable')
    assert.equal(outcome.envrcPath, path.join(dir, '.envrc'))
    assert.match(evaluator.status(dir).errorSummary!, /unreadable/)
    assert.deepEqual(evaluator.peekEnv(dir), {})
  } finally {
    fs.chmodSync(path.join(dir, '.envrc'), 0o644)
  }
})

// Not allowed: exit code 1 plus one `direnv: error … is blocked …` line. The
// blocked env must never be injectable.
test('blocked: unapproved .envrc', async () => {
  const dir = fixture('blocked', { '.envrc': 'export BLOCKED_SECRET=leak\n' })
  const evaluator = makeEvaluator()
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'blocked')
  assert.equal(outcome.envrcPath, path.join(dir, '.envrc'))
  assert.match(outcome.stderr, /is blocked\. Run `direnv allow` to approve its content/)
  assert.ok(!('overlay' in outcome))
  assert.deepEqual(evaluator.peekEnv(dir), {})
  assert.deepEqual(await evaluator.ensureEnv(dir), {})
  assert.equal(evaluator.status(dir).state, 'blocked')
  assert.match(evaluator.status(dir).errorSummary!, /^blocked: /)
})

// A blocked verdict is remembered, so it must also notice the allow library
// changing under it; otherwise `direnv allow` would never take effect.
test('blocked -> allowed: allow library change invalidates the record', async () => {
  const dir = fixture('blocked-then-allowed', { '.envrc': 'export LATE=yes\n' })
  const evaluator = makeEvaluator()
  const before = await evaluator.evaluate(dir)
  assert.equal(before.kind, 'blocked')

  allow(dir)
  const after = await evaluator.evaluate(dir)
  assert.equal(after.kind, 'ok')
  assert.equal(after.overlay.LATE, 'yes')
})

// An .envrc that prints a fake blocked line on exit 0 must stay `ok`: on a
// successful run stderr is never classification input.
test('forged blocked line on exit 0 is only a warning', async () => {
  const dir = fixture('forged-blocked-ok', {
    '.envrc': [
      "printf 'direnv: error %s is blocked. Run `direnv allow` to approve its content\\n' \"$PWD/.envrc\" >&2",
      'export FORGED=ok',
      '',
    ].join('\n'),
  })
  allow(dir)
  const outcome = await makeEvaluator().evaluate(dir)

  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.overlay.FORGED, 'ok')
  assert.equal(outcome.degraded, true)
})

// Same forgery with a non-zero exit: two `direnv: error` lines, so the
// "exactly one error line" rule keeps it out of `blocked` (the fake line alone
// would fool an `includes('is blocked')` check).
test('forged blocked line with exit N is envrc-failed, not blocked', async () => {
  const dir = fixture('forged-blocked-fail', {
    '.envrc': [
      "printf 'direnv: error %s is blocked. Run `direnv allow` to approve its content\\n' \"$PWD/.envrc\" >&2",
      'exit 3',
      '',
    ].join('\n'),
  })
  allow(dir)
  const outcome = await makeEvaluator().evaluate(dir)

  assert.equal(outcome.kind, 'envrc-failed')
  assert.equal(outcome.status, 3)
  assert.match(outcome.stderr, /is blocked/, 'the forged line is present in stderr')
  assert.match(outcome.stderr, /direnv: error exit status 3/)
})

// The same forgery aimed at the other text verdict: printing a fake
// `direnv: error exit status 99` before really exiting 3 leaves two lines of
// that shape on stderr, so no status is trustworthy and the run has to land in
// the transient `error` bucket instead of reporting `envrc-failed/99`.
test('forged exit status: a fake line cannot shadow the real one', async () => {
  const dir = fixture('forged-exit-status', {
    '.envrc': "printf 'direnv: error exit status 99\\n' >&2\nexit 3\n",
  })
  allow(dir)
  const evaluator = makeEvaluator()
  const outcome = await evaluator.evaluate(dir)

  assert.match(stderrOf(outcome), /direnv: error exit status 99/, 'the forged line really is on stderr')
  assert.match(stderrOf(outcome), /direnv: error exit status 3/, 'so is the real one')
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.reason, 'ambiguous-exit-status')
  assert.equal(probeField(outcome, 'status'), undefined, 'the forged status must never surface as `status`')
  assert.equal(evaluator.status(dir).errorSummary, 'ambiguous exit status (stderr is not trustworthy)')
  assert.equal(evaluator.peekEnv(dir), undefined, 'an ambiguous verdict is transient, not "nothing to inject"')
})

// `.env` alone is not an RC unless load_dotenv is on: with it off the run is
// indistinguishable from `absent`, with it on `.env` becomes the RC itself.
test('.env only: absent with load_dotenv=false, real RC with load_dotenv=true', async () => {
  const dir = fixture('dotenv-only', {
    '.env': 'DOTENV_ONLY=1\n',
    'cfg/direnv.toml': 'load_dotenv = false\n',
  })
  const off = { DIRENV_CONFIG: path.join(dir, 'cfg') }
  const absent = await makeEvaluator({ env: off }).evaluate(dir)
  assert.equal(absent.kind, 'absent')

  fs.writeFileSync(path.join(dir, 'cfg', 'direnv.toml'), 'load_dotenv = true\n')
  const on = makeEvaluator({ env: off })
  const blocked = await on.evaluate(dir)
  assert.equal(blocked.kind, 'blocked', 'with load_dotenv the .env must be approved')

  allow(dir, off)
  const outcome = await on.evaluate(dir)
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.envrcPath, path.join(dir, '.env'))
  assert.equal(outcome.overlay.DOTENV_ONLY, '1')
})

// direnv.toml that fails to parse: exit 1 with completely empty stdout, only
// the stderr text identifies it.
test('config-error: unparseable direnv.toml', async () => {
  const dir = fixture('config-error', {
    '.envrc': 'export NEVER=1\n',
    'cfg/direnv.toml': '[[[ not toml\n',
  })
  const evaluator = makeEvaluator({ env: { DIRENV_CONFIG: path.join(dir, 'cfg') } })
  const outcome = await evaluator.evaluate(dir)

  assert.equal(outcome.kind, 'config-error')
  assert.match(outcome.stderr, /LoadConfig\(\) failed to parse/)
  assert.match(evaluator.status(dir).errorSummary!, /LoadConfig/)
})
