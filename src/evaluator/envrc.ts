/**
 * Finding the nearest `.envrc`, and telling "no RC" apart from "an RC I may not
 * read".
 *
 * `direnv export json` answers an empty stdout for both, so the only honest
 * source for that difference is our own stat/access pair. `probeFile` carries
 * just the two facts the classifier may use (`exists`, `readable`): file
 * metadata is deliberately not carried along, because the memo key
 * re-fingerprints the RC by content anyway (`fingerprint.ts`).
 */

import fs from 'node:fs'
import path from 'node:path'

import { errorCode } from './errors.ts'
import type { EvaluatorDeps } from '../types.ts'

/** The stat/read primitives a probe needs, so a test can inject a broken filesystem. */
export type ProbeDeps = Pick<EvaluatorDeps, 'stat' | 'readFile' | 'access'>

export interface EnvrcProbe {
  path: string
  exists: boolean
  readable: boolean
}

export type ReadResult = { ok: true; content: string } | { ok: false; code: string }

/**
 * Read a file the way the evaluator needs it: a non-string answer is coerced
 * (`String(content ?? '')`), and any failure comes back as an errno code instead
 * of an exception — a fingerprint must degrade, not abort the memo key.
 */
export async function readText(deps: ProbeDeps, target: string): Promise<ReadResult> {
  try {
    const content = await deps.readFile(target, 'utf8')
    return typeof content === 'string' ? { ok: true, content } : { ok: true, content: String(content ?? '') }
  } catch (error) {
    return { ok: false, code: errorCode(error) ?? 'ERR' }
  }
}

async function canRead(deps: ProbeDeps, target: string): Promise<boolean> {
  try {
    await deps.access(target, fs.constants.R_OK)
    return true
  } catch (error) {
    // Only a permission denial means "unreadable"; anything else is treated as
    // readable so a raced ENOENT cannot masquerade as chmod 000.
    const code = errorCode(error)
    return !(code === 'EACCES' || code === 'EPERM')
  }
}

/**
 * `exists` / `readable` for one candidate RC.
 *
 * A stat that fails with EACCES/EPERM still means the file is there (the walk
 * must not step over a readable RC further up because a nearer one is shielded);
 * every other failure — ENOENT, ENOTDIR, a hostile injected stat — is "no RC
 * here". A non-file that exists (a directory named `.envrc`) is never readable.
 */
export async function probeFile(deps: ProbeDeps, target: string): Promise<EnvrcProbe> {
  let st
  try {
    st = await deps.stat(target)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EACCES' || code === 'EPERM') return { path: target, exists: true, readable: false }
    return { path: target, exists: false, readable: false }
  }
  if (!st.isFile()) return { path: target, exists: true, readable: false }
  const modeAllows = st.mode === undefined ? true : (st.mode & 0o444) !== 0
  const readable = modeAllows ? await canRead(deps, target) : false
  return { path: target, exists: true, readable }
}

/**
 * Nearest `.envrc`, walking up exactly like direnv does. `hint` (the path a
 * previous run reported) short-circuits the common workspace-root case only when
 * it is the RC of `dir` itself — a nearer RC may have appeared since.
 */
export async function findEnvrc(deps: ProbeDeps, dir: string, hint: string | null): Promise<EnvrcProbe> {
  const localPath = path.join(dir, '.envrc')
  if (hint === localPath) {
    const local = await probeFile(deps, localPath)
    if (local.exists) return local
  }
  let current = dir
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = await probeFile(deps, path.join(current, '.envrc'))
    if (candidate.exists) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return { path: localPath, exists: false, readable: false }
}
