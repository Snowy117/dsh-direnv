/**
 * The one reader of `package.json` for the test suite.
 *
 * Three checks resolve the served client artifact from the single field the web
 * carrier reads (`exports["./client"]`), and the boot acceptance check compares
 * the served module against exactly that file. `JSON.parse` is a real boundary,
 * so the shape is proved here once instead of being re-derived at every use.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isRecord, isStringArray } from './guards.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The repository root, from this file's own location (never from the cwd). */
export const REPO = path.resolve(HERE, '..', '..')

export interface PackageManifest {
  /** `exports["./client"]`, resolved against the repository root. */
  clientFile: string
  /** `dsh.client.inject`: the exact list the boot payload has to carry. */
  clientInject: string[]
}

function readManifest(): PackageManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  if (!isRecord(parsed)) throw new Error('package.json is not an object')
  const exportsField = parsed.exports
  const clientFile = isRecord(exportsField) ? exportsField['./client'] : undefined
  if (typeof clientFile !== 'string') throw new Error('package.json carries no exports["./client"]')
  const dsh = parsed.dsh
  const client = isRecord(dsh) ? dsh.client : undefined
  const inject = isRecord(client) ? client.inject : undefined
  if (!isStringArray(inject)) throw new Error('package.json carries no dsh.client.inject list')
  return { clientFile: path.resolve(REPO, clientFile), clientInject: inject }
}

export const MANIFEST: PackageManifest = readManifest()

/** The served artifact, resolved from the one field the web carrier reads. */
export const CLIENT_FILE = MANIFEST.clientFile
