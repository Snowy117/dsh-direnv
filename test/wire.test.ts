/**
 * The status route's parsing boundary, exercised on raw `JSON.parse` output.
 *
 * `parseEnvelope` is the only reader of the wire format, and the browser half
 * reaches it through `client/status-view.ts`. Its contract is asymmetric on
 * purpose: a body that is not an answer to this route at all (the SPA document,
 * a record with no `state`) is rejected, while a body that answers with fewer
 * fields is accepted and defaulted. This file pins that split for the `PATH`
 * diff, where a missing or unreadable `change` must never be guessed at.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseEnvelope } from '../src/wire.ts'
import type { PathEntry } from '../src/types.ts'

function recordWith(pathEntries: unknown): unknown {
  return { dir: '/work/a', state: 'ok', pathEntries: pathEntries }
}

function entriesOf(pathEntries: unknown): PathEntry[] | null {
  const envelope = parseEnvelope(recordWith(pathEntries))
  return envelope === null || envelope.status === null ? null : envelope.status.pathEntries
}

test('a well-formed diff parses as-is, order included', () => {
  const entries = [
    { value: '/nix/store/abc/bin', change: 'added' },
    { value: '/opt/gone/bin', change: 'removed' },
    { value: '/usr/bin', change: 'unchanged' },
  ]
  assert.deepEqual(entriesOf(entries), entries)
})

test('a missing or non-array pathEntries degrades to an empty diff', () => {
  assert.deepEqual(entriesOf(undefined), [])
  assert.deepEqual(entriesOf(null), [])
  assert.deepEqual(entriesOf('/usr/bin:/opt/bin'), [])
  assert.deepEqual(entriesOf({ value: '/usr/bin', change: 'unchanged' }), [])
})

test('an entry with an unreadable change is dropped, never defaulted to unchanged', () => {
  const parsed = entriesOf([
    { value: '/usr/bin', change: 'unchanged' },
    { value: '/opt/a', change: 'ADDED' },
    { value: '/opt/b', change: '' },
    { value: '/opt/c', change: 42 },
    { value: '/opt/d' },
    { value: '/opt/e', change: null },
  ])
  assert.deepEqual(parsed, [{ value: '/usr/bin', change: 'unchanged' }])
})

test('an entry that is not a value-bearing object is dropped', () => {
  const parsed = entriesOf([
    'nonsense',
    42,
    null,
    [],
    { change: 'added' },
    { value: 42, change: 'added' },
    { value: null, change: 'removed' },
    { value: '/usr/bin', change: 'added' },
  ])
  assert.deepEqual(parsed, [{ value: '/usr/bin', change: 'added' }])
})

test('an empty component survives the wire, and extra keys are ignored', () => {
  assert.deepEqual(entriesOf([{ value: '', change: 'added', future: true }]), [{ value: '', change: 'added' }])
})

test('the flat record shape carries the diff too, and a missing PATH is not an error', () => {
  const flat = { dir: '/work/a', state: 'ok', pathEntries: [{ value: '/a', change: 'added' }] }
  assert.deepEqual(parseEnvelope(flat)?.status?.pathEntries, [{ value: '/a', change: 'added' }])
  assert.deepEqual(entriesOf(undefined), [])
  assert.notEqual(parseEnvelope(recordWith(undefined)), null, 'a record without pathEntries is still a record')
})

test('a body that is not this route still answers null', () => {
  assert.equal(parseEnvelope('<!doctype html><html></html>'), null)
  assert.equal(parseEnvelope({ ok: false, status: { state: 'ok' } }), null)
  assert.equal(parseEnvelope({ dir: '/work/a' }), null, 'a record with no state is not a record')
})
