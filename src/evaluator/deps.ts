/**
 * The injected dependency seam, and the primitives derived from it.
 *
 * Everything the evaluator touches outside its own memory goes through
 * `EvaluatorDeps`; this file normalises what a host (or a test) passed in, and
 * it owns the base-environment policy:
 *
 * - **No `DIRENV_*` load state may reach direnv.** `DIRENV_DIFF` / `DIR` /
 *   `FILE` / `WATCHES` turn the call into "unload the previous directory", which
 *   restores harness-scrubbed secrets by name (`Revert()` re-applies the `p`
 *   section of the diff). One dirty variable is enough to leak one.
 * - **`DIRENV_CONFIG` / `DIRENV_LOG_FORMAT` / `HOME` / `XDG_*` stay.** They are
 *   user configuration and data locations, not load state: the allow library and
 *   nix-direnv live there, and dropping `DIRENV_CONFIG` silently makes every
 *   directory whose allow state lives elsewhere look blocked.
 * - Non-string values are dropped: the base is handed to `spawn` verbatim.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'

import { defaultSpawnDirenv } from './spawn.ts'
import type { AmbientEnv, DirenvBaseEnv, EvaluatorDeps, EvaluatorDepsInput } from '../types.ts'

/** Every one of direnv's own variables is prefixed this way. */
export const DIRENV_KEY = /^DIRENV_/

/**
 * The `DIRENV_*` keys that are *configuration* rather than load state, plus the
 * environment direnv resolves its config/data/allow library through.
 *
 * Folded into the memo key next to `PATH`: changing any of them changes what
 * direnv will say about the same RC.
 */
export const CONFIG_ENV_KEYS: readonly string[] = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'DIRENV_CONFIG',
  'DIRENV_LOG_FORMAT',
]

function defaultHash(value: string): string {
  return createHash('sha256').update(String(value)).digest('hex')
}

/** Fill in the real implementation for every dependency the caller left out. */
export function resolveDeps(injected: EvaluatorDepsInput | undefined): EvaluatorDeps {
  const source = injected ?? {}
  return {
    baseEnv: typeof source.baseEnv === 'function' ? source.baseEnv : () => process.env,
    stat: typeof source.stat === 'function' ? source.stat : (target) => fs.promises.stat(target),
    readFile:
      typeof source.readFile === 'function'
        ? source.readFile
        : (target, encoding) => fs.promises.readFile(target, encoding),
    readdir: typeof source.readdir === 'function' ? source.readdir : (target) => fs.promises.readdir(target),
    access: typeof source.access === 'function' ? source.access : (target, mode) => fs.promises.access(target, mode),
    realpath: typeof source.realpath === 'function' ? source.realpath : (target) => fs.promises.realpath(target),
    now: typeof source.now === 'function' ? source.now : () => Date.now(),
    hash: typeof source.hash === 'function' ? source.hash : defaultHash,
    spawnDirenv: typeof source.spawnDirenv === 'function' ? source.spawnDirenv : defaultSpawnDirenv,
  }
}

/** A clock that cannot break evaluation: a throwing or non-finite `now` falls back to `Date.now()`. */
export function nowMs(deps: EvaluatorDeps): number {
  try {
    const value = deps.now()
    return Number.isFinite(value) ? Number(value) : Date.now()
  } catch {
    return Date.now()
  }
}

/** A hash that cannot break evaluation: a throwing `hash` falls back to sha256. */
export function hashString(deps: EvaluatorDeps, value: string): string {
  try {
    return String(deps.hash(String(value)))
  } catch {
    return defaultHash(String(value))
  }
}

/** The ambient environment minus direnv's load state — see this file's header. */
export function baseEnv(deps: EvaluatorDeps): DirenvBaseEnv {
  let raw: AmbientEnv
  try {
    raw = deps.baseEnv()
  } catch {
    raw = process.env
  }
  const out: DirenvBaseEnv = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (DIRENV_KEY.test(key) && !CONFIG_ENV_KEYS.includes(key)) continue
    if (typeof value !== 'string') continue
    out[key] = value
  }
  return out
}
