/**
 * The sidebar's derived facts, exercised as a pure function.
 *
 * `deriveFacts` is where "direnv changed PATH" becomes something a reader can
 * look at, so this file pins the three change kinds, the *multiset* pairing rule
 * (a repeated directory is two priority slots, not one) and the order in which a
 * removal is emitted. `test/evaluator-runtime.test.ts` covers the same function
 * through a real direnv run; this one covers the shapes a real run cannot be
 * asked to produce on demand.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveFacts } from '../src/evaluator/derive.ts'
import type { PathEntry } from '../src/types.ts'

function entriesOf(path: string, base: string | undefined): PathEntry[] {
  return deriveFacts({ PATH: path, FOO: 'bar' }, base).pathEntries
}

/** `value:change` pairs, so a failed diff reads at a glance. */
function pairs(entries: readonly PathEntry[]): string[] {
  return entries.map((entry) => `${entry.value}:${entry.change}`)
}

test('an unchanged PATH is a list of unchanged entries, in the overlay order', () => {
  assert.deepEqual(pairs(entriesOf('/usr/bin:/opt/tools', '/usr/bin:/opt/tools')), [
    '/usr/bin:unchanged',
    '/opt/tools:unchanged',
  ])
})

test('an added entry leads, a removed one is emitted where the base had it', () => {
  const base = '/usr/bin:/opt/legacy/bin:/work/ws/bin'
  const next = '/nix/store/abc/bin:/work/ws/bin:/usr/bin'
  assert.deepEqual(pairs(entriesOf(next, base)), [
    '/nix/store/abc/bin:added',
    '/opt/legacy/bin:removed',
    '/work/ws/bin:unchanged',
    '/usr/bin:unchanged',
  ])
})

test('a shortened PATH appends what nothing pairs with', () => {
  assert.deepEqual(pairs(entriesOf('/usr/bin', '/usr/bin:/opt/a:/opt/b')), [
    '/usr/bin:unchanged',
    '/opt/a:removed',
    '/opt/b:removed',
  ])
})

test('a repeated entry pairs by occurrence, never by membership', () => {
  // Two `/a` in the new PATH, two in the base: neither is a diff. The dropped
  // `/b` was never in the new list, and the new `/c` was never in the base.
  assert.deepEqual(pairs(entriesOf('/a:/a:/c', '/a:/b:/a')), [
    '/a:unchanged',
    '/b:removed',
    '/a:unchanged',
    '/c:added',
  ])
  assert.deepEqual(pairs(entriesOf('/a', '/a:/a')), ['/a:unchanged', '/a:removed'])
  assert.deepEqual(pairs(entriesOf('/a:/a', '/a')), ['/a:unchanged', '/a:added'])
})

test('a missing base PATH makes every entry an addition, and never throws', () => {
  assert.deepEqual(pairs(entriesOf('/usr/bin:/opt/tools', undefined)), ['/usr/bin:added', '/opt/tools:added'])
})

test('a PATH that direnv did not produce is an empty diff, not an error', () => {
  assert.deepEqual(deriveFacts({ FOO: 'bar' }, '/usr/bin').pathEntries, [])
  assert.deepEqual(deriveFacts({ PATH: null, FOO: 'bar' }, '/usr/bin').pathEntries, [])
})

test('empty components are carried through as their own entries', () => {
  // An empty component is a real PATH element (it means "the current directory"),
  // and two of them pair by count like any other repeated entry.
  assert.deepEqual(pairs(entriesOf(':/usr/bin:', '/usr/bin')), [':added', '/usr/bin:unchanged', ':added'])
  assert.deepEqual(pairs(entriesOf('', ':')), [':unchanged', ':removed'])
})

test('only the diff is reported, never the absolute PATH', () => {
  const facts = deriveFacts({ PATH: '/a:/usr/bin' }, '/usr/bin:/sbin')
  assert.deepEqual(pairs(facts.pathEntries), ['/a:added', '/usr/bin:unchanged', '/sbin:removed'])
})
