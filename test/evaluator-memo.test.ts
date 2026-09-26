/**
 * The memo key: what a second evaluation may reuse, and what has to invalidate it.
 *
 * Every case runs the real direnv against the same fixture more than once and
 * proves the later run either reused the record (the RC's own counter file did
 * not grow) or really re-ran it. Fixtures and the real-direnv runner live in
 * test/helpers/evaluator-fixtures.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { allow, counterValue, fixture, makeEvaluator, pinMtime, rewriteInPlace } from './helpers/evaluator-fixtures.ts'
import type { OkOutcome } from '../src/types.ts'

/**
 * A memo case reads the `ok` fields of an evaluation (`memoHit`, `overlay`,
 * `watches`) without first asserting the verdict — that is what the case is
 * about — so the record shape is stated where the record is produced.
 */

// direnv.toml is in the memo key for *every* record, not just `ok` ones: a
// config-only change must re-run an `absent` directory. `false` -> `true ` is
// the same byte length, and the mtime is pinned back, so a metadata-only key
// cannot see the flip — only the content hash can.
test('memo: direnv.toml change invalidates a non-ok record', async () => {
  const dir = fixture('memo-toml', {
    '.env': 'DOTENV_ONLY=1\n',
    'cfg/direnv.toml': 'load_dotenv = false\n',
  })
  const toml = path.join(dir, 'cfg', 'direnv.toml')
  pinMtime(toml)
  const evaluator = makeEvaluator({ env: { DIRENV_CONFIG: path.join(dir, 'cfg') } })
  assert.equal((await evaluator.evaluate(dir)).kind, 'absent')

  rewriteInPlace(toml, 'load_dotenv = true \n')
  const after = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(after.kind, 'blocked')
  assert.equal(evaluator.status(dir).memoHit, false)
})

// The RC really is executed on every direnv call (no cross-process cache), so a
// memo hit must be provable by the RC *not* running: the counter file is not
// watched and not part of the key.
test('memo hit: second evaluation does not re-run the RC', async () => {
  const dir = fixture('memo-hit', {
    '.envrc': 'echo run >> counter.txt\nexport MEMO_VALUE=one\n',
  })
  allow(dir)
  const evaluator = makeEvaluator()

  const first = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(first.kind, 'ok')
  assert.equal(first.memoHit, false)
  assert.equal(counterValue(dir), 1)

  const second = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(second.kind, 'ok')
  assert.equal(second.memoHit, true)
  assert.equal(counterValue(dir), 1, 'the RC must not run again on a memo hit')
  assert.deepEqual(second.overlay, first.overlay)
  assert.equal(second.at, first.at, 'at is when the data was produced')
  assert.equal(evaluator.status(dir).memoHit, true)
})

// Editing the RC changes its content hash, so the memo must miss even inside
// the same second (watches only carry second-precision modtimes).
test('memo invalidation: edited .envrc', async () => {
  const dir = fixture('memo-envrc-edit', {
    '.envrc': 'echo run >> counter.txt\nexport MEMO_VALUE=one\n',
  })
  allow(dir)
  const evaluator = makeEvaluator()
  assert.equal(((await evaluator.evaluate(dir)) as OkOutcome).overlay.MEMO_VALUE, 'one')

  fs.writeFileSync(path.join(dir, '.envrc'), 'echo run >> counter.txt\nexport MEMO_VALUE=two\n')
  allow(dir)
  const after = (await evaluator.evaluate(dir)) as OkOutcome

  assert.equal(after.memoHit, false)
  assert.equal(after.overlay.MEMO_VALUE, 'two')
  assert.equal(counterValue(dir), 2)
})

// The RC's *watch* entry only carries mtime+size, so the content hash is the
// only thing that can catch a rewrite which preserves both. The whitelist
// approves by path, keeping the allow library (also part of the key) still.
test('memo invalidation: .envrc rewritten in place with identical size and mtime', async () => {
  const dir = fixture('memo-envrc-inplace', {
    '.envrc': 'echo run >> counter.txt\nexport RC="one"\n',
  })
  const toml = path.join(dir, 'cfg', 'direnv.toml')
  fs.mkdirSync(path.dirname(toml), { recursive: true })
  fs.writeFileSync(toml, `[whitelist]\nprefix = ["${dir}"]\n`)
  pinMtime(path.join(dir, '.envrc'))
  const evaluator = makeEvaluator({ env: { DIRENV_CONFIG: path.join(dir, 'cfg') } })

  const first = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(first.kind, 'ok')
  assert.equal(first.overlay.RC, 'one')
  assert.ok(first.watches!.some((watch) => watch.path === path.join(dir, '.envrc')))

  rewriteInPlace(path.join(dir, '.envrc'), 'echo run >> counter.txt\nexport RC="two"\n')
  const second = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(second.memoHit, false)
  assert.equal(second.overlay.RC, 'two')
  assert.equal(counterValue(dir), 2)
})

// `.env` is a memo input in its own right, and it *becomes* the RC once
// load_dotenv is on: a same-size, same-mtime rewrite must still invalidate.
test('memo invalidation: .env rewritten in place with identical size and mtime', async () => {
  const dir = fixture('memo-dotenv-inplace', { '.env': 'DOTENV=one\n' })
  const toml = path.join(dir, 'cfg', 'direnv.toml')
  fs.mkdirSync(path.dirname(toml), { recursive: true })
  fs.writeFileSync(toml, `load_dotenv = true\n[whitelist]\nprefix = ["${dir}"]\n`)
  pinMtime(path.join(dir, '.env'))
  const evaluator = makeEvaluator({ env: { DIRENV_CONFIG: path.join(dir, 'cfg') } })

  const first = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(first.kind, 'ok')
  assert.equal(first.envrcPath, path.join(dir, '.env'))
  assert.equal(first.overlay.DOTENV, 'one')

  rewriteInPlace(path.join(dir, '.env'), 'DOTENV=two\n')
  const second = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(second.memoHit, false)
  assert.equal(second.overlay.DOTENV, 'two')
})

// watch_file targets are in DIRENV_WATCHES, so touching one must invalidate.
test('memo invalidation: watched file changes', async () => {
  const dir = fixture('memo-watch-file', {
    '.envrc': 'echo run >> counter.txt\nwatch_file ./watched.txt\nexport WATCHED="$(cat watched.txt)"\n',
    'watched.txt': 'one\n',
  })
  allow(dir)
  const evaluator = makeEvaluator()
  const first = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(first.overlay.WATCHED, 'one')
  assert.ok(first.watches!.some((watch) => watch.path === path.join(dir, 'watched.txt')))

  fs.writeFileSync(path.join(dir, 'watched.txt'), 'two\n')
  const second = (await evaluator.evaluate(dir)) as OkOutcome

  assert.equal(second.memoHit, false)
  assert.equal(second.overlay.WATCHED, 'two')
  assert.equal(counterValue(dir), 2)
})

// `lib/*.sh` is where nix-direnv lives and it is NOT in DIRENV_WATCHES: a
// watches-only memo key would return stale values here. The first edit keeps
// the byte length and the mtime, so only a content fingerprint can see it.
test('memo invalidation: DIRENV_CONFIG/lib/*.sh changes', async () => {
  const dir = fixture('memo-lib', {
    '.envrc': 'echo run >> counter.txt\nexport FROM_LIB="$(lib_value)"\n',
    'cfg/lib/zz-test.sh': 'lib_value() { echo one; }\n',
  })
  const env = { DIRENV_CONFIG: path.join(dir, 'cfg') }
  const lib = path.join(dir, 'cfg', 'lib', 'zz-test.sh')
  pinMtime(lib)
  allow(dir, env)
  const evaluator = makeEvaluator({ env })

  const first = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(first.overlay.FROM_LIB, 'one')
  assert.ok(first.watches!.every((watch) => !watch.path.endsWith('zz-test.sh')), 'lib scripts are not watched')
  assert.equal(((await evaluator.evaluate(dir)) as OkOutcome).memoHit, true)

  rewriteInPlace(lib, 'lib_value() { echo two; }\n')
  const second = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(second.memoHit, false)
  assert.equal(second.overlay.FROM_LIB, 'two')
  assert.equal(counterValue(dir), 2)

  fs.writeFileSync(lib, 'lib_value() { echo three-longer; }\n')
  const third = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(third.memoHit, false)
  assert.equal(third.overlay.FROM_LIB, 'three-longer')
  assert.equal(counterValue(dir), 3)
})

// nix-direnv touches `.direnv/flake-profile-*.rc` on every hot run and watches
// that file: keying on its mtime would make the memo miss forever in exactly
// the workspaces it exists for. Existence must still be part of the key.
test('memo: a .direnv cache entry touched between runs does not invalidate', async () => {
  const dir = fixture('memo-layout-touch', {
    '.envrc': [
      'echo run >> counter.txt',
      'mkdir -p .direnv',
      'echo cache > .direnv/cache.txt',
      'watch_file ./.direnv/cache.txt',
      'export LAYOUT=stable',
      '',
    ].join('\n'),
  })
  allow(dir)
  const evaluator = makeEvaluator()
  const first = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(first.overlay.LAYOUT, 'stable')
  assert.ok(first.watches!.some((watch) => watch.path === path.join(dir, '.direnv', 'cache.txt')))
  assert.equal(evaluator.status(dir).watchCount, first.watches!.length)

  // simulate nix-direnv's `touch -h` on the cache entry
  const target = path.join(dir, '.direnv', 'cache.txt')
  const before = fs.statSync(target).mtimeMs
  fs.utimesSync(target, new Date(), new Date(Date.now() + 5000))
  assert.notEqual(fs.statSync(target).mtimeMs, before)

  const second = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(second.memoHit, true, 'cache touches must not invalidate the memo')
  assert.equal(counterValue(dir), 1)

  fs.rmSync(target, { force: true })
  const third = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(third.memoHit, false, 'deleting the cache entry must invalidate')
  assert.equal(counterValue(dir), 2)
})

// nix-direnv's real shape, reproduced without touching any real workspace: a
// watched `.direnv/<profile>.rc` whose body *is* the dev-shell PATH, `touch -h`ed
// on every hot run, plus the same shape under `$XDG_CACHE_HOME/direnv`. The memo
// must ignore the churn, follow a rebuilt profile, and notice a deletion.
test('memo: nix-direnv shaped profile rc (touch churn, rebuild, deletion)', async () => {
  const xRcRelative = '.direnv/flake-profile-x.rc'
  const xOne = [
    'export PATH="/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-profile-x-one/bin:$PATH"',
    'export PROFILE_X=one',
    '',
  ].join('\n')
  const dir = fixture('memo-nix-direnv-shape', {
    '.envrc': [
      'echo run >> counter.txt',
      `watch_file ${xRcRelative}`,
      'watch_file "$XDG_CACHE_HOME/direnv/flake-profile-y.rc"',
      `eval "$(cat ${xRcRelative})"`,
      'eval "$(cat "$XDG_CACHE_HOME/direnv/flake-profile-y.rc")"',
      '',
    ].join('\n'),
    [xRcRelative]: xOne,
  })
  const xRc = path.join(dir, xRcRelative)
  const yRc = path.join(dir, 'xdg-cache', 'direnv', 'flake-profile-y.rc')
  fs.mkdirSync(path.dirname(yRc), { recursive: true })
  fs.writeFileSync(
    yRc,
    [
      'export PATH="/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-profile-y-one/bin:$PATH"',
      'export PROFILE_Y=one',
      '',
    ].join('\n'),
  )
  const env = { XDG_CACHE_HOME: path.join(dir, 'xdg-cache') }
  pinMtime(xRc)
  pinMtime(yRc)
  allow(dir, env)
  const evaluator = makeEvaluator({ env })

  const first = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(first.kind, 'ok')
  assert.equal(first.overlay.PROFILE_X, 'one')
  assert.equal(first.overlay.PROFILE_Y, 'one')
  assert.match(first.overlay.PATH!, /profile-x-one\/bin/)
  assert.match(first.overlay.PATH!, /profile-y-one\/bin/)
  const watched = new Set(first.watches!.map((watch) => watch.path))
  assert.ok(watched.has(xRc), 'the .direnv profile is watched')
  assert.ok(watched.has(yRc), 'the $XDG_CACHE_HOME profile is watched')

  // ① a hot run's `touch -h` must never invalidate the memo
  for (let round = 1; round <= 3; round += 1) {
    const stamp = new Date(Date.now() + round * 5000)
    fs.utimesSync(xRc, stamp, stamp)
    fs.utimesSync(yRc, stamp, stamp)
    const touched = (await evaluator.evaluate(dir)) as OkOutcome
    assert.equal(touched.memoHit, true, `touch round ${round} must still hit`)
    assert.equal(touched.overlay.PATH, first.overlay.PATH)
  }
  assert.equal(counterValue(dir), 1, 'churn alone never re-runs the RC')

  // ② a rebuilt profile (same byte length, same mtime) must invalidate
  const xTwo = [
    'export PATH="/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-profile-x-two/bin:$PATH"',
    'export PROFILE_X=two',
    '',
  ].join('\n')
  rewriteInPlace(xRc, xTwo)
  const rebuilt = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(rebuilt.memoHit, false)
  assert.equal(rebuilt.overlay.PROFILE_X, 'two')
  assert.match(rebuilt.overlay.PATH!, /profile-x-two\/bin/, 'the new store path is injected')
  assert.ok(!rebuilt.overlay.PATH!.includes('profile-x-one'), 'the old store path is gone')
  assert.equal(counterValue(dir), 2)

  // the `$XDG_CACHE_HOME/direnv` half is keyed by content too
  rewriteInPlace(yRc, fs.readFileSync(yRc, 'utf8').replace('PROFILE_Y=one', 'PROFILE_Y=two'))
  const rebuiltY = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(rebuiltY.memoHit, false)
  assert.equal(rebuiltY.overlay.PROFILE_Y, 'two')
  assert.equal(counterValue(dir), 3)

  // ③ deleting the profile must invalidate as well
  fs.rmSync(xRc)
  const deleted = (await evaluator.evaluate(dir)) as OkOutcome
  assert.equal(deleted.memoHit, false)
  assert.equal(deleted.kind, 'ok')
  assert.equal(deleted.overlay.PROFILE_X, undefined)
  assert.equal(counterValue(dir), 4)
})
