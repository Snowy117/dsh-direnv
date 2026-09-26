/**
 * `DIRENV_WATCHES` — the list of paths direnv itself says the RC depends on.
 *
 * direnv ships that list as base64(zlib(JSON)) in the exported environment, and
 * the encoding is not stable across versions, so decoding tries every codec a
 * real direnv has produced and gives up quietly (`null`). Watches are the
 * evaluator's *first* invalidation signal but never the only one: they miss
 * `direnv.toml`, `lib/*.sh`, `PATH`, the binary and the allow library, which is
 * why `fingerprint.ts` keys on all of those too.
 */

import path from 'node:path'
import zlib from 'node:zlib'

import type { DirenvBaseEnv, Watch } from '../types.ts'

interface RawWatchEntry {
  path: string
  modtime?: unknown
  exists?: unknown
}

function isRawWatchEntry(entry: unknown): entry is RawWatchEntry {
  if (typeof entry !== 'object' || entry === null || !('path' in entry)) return false
  return typeof entry.path === 'string'
}

/** Decode `DIRENV_WATCHES` (base64 + zlib of a `{path,modtime,exists}[]`). */
export function decodeWatches(raw: unknown): Watch[] | null {
  if (typeof raw !== 'string' || raw === '') return null
  const attempts: (() => string)[] = []
  try {
    const bytes = Buffer.from(raw, 'base64')
    attempts.push(() => zlib.inflateSync(bytes).toString('utf8'))
    attempts.push(() => zlib.inflateRawSync(bytes).toString('utf8'))
    attempts.push(() => bytes.toString('utf8'))
  } catch {
    /* not base64 after all */
  }
  attempts.push(() => raw)
  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt())
      if (!Array.isArray(parsed)) continue
      return parsed
        .filter((entry) => isRawWatchEntry(entry))
        .map((entry) => ({
          path: entry.path,
          modtime: Number(entry.modtime) || 0,
          exists: entry.exists === true,
        }))
    } catch {
      /* try the next codec */
    }
  }
  return null
}

/**
 * direnv's layout directory (`.direnv`, or `$XDG_CACHE_HOME/direnv` when
 * configured) is a churn-heavy input: nix-direnv `touch -h`es its gcroot
 * symlinks and its `flake-profile-*.rc` on *every* hot run, and it watches that
 * `.rc` file. Keying such a path by mtime would invalidate the memo on every
 * single run — the cache would never hit for the workspaces that need it — so
 * these paths are keyed by content instead, which survives the touch churn and
 * still notices a rebuilt profile.
 */
export function isDirenvCachePath(target: string, base: DirenvBaseEnv): boolean {
  if (/(^|\/)\.direnv(\/|$)/.test(target)) return true
  const cacheHome = base.XDG_CACHE_HOME || (base.HOME ? path.join(base.HOME, '.cache') : '')
  return cacheHome !== '' && target.startsWith(`${path.join(cacheHome, 'direnv')}${path.sep}`)
}
