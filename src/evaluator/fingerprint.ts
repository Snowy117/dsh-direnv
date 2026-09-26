/**
 * The memo key: every input direnv actually looks at, fingerprinted.
 *
 * The key is deliberately wider than `DIRENV_WATCHES`. Watches miss
 * `direnv.toml`, `lib/*.sh` (where nix-direnv lives), `PATH`, the direnv binary,
 * the allow/deny library and the RC file itself, so a watches-only key hands
 * back *stale* values — worse than no cache at all.
 *
 * Two fingerprint strategies, and the choice between them is load-bearing:
 *
 * - Paths inside `.direnv/` / `$XDG_CACHE_HOME/direnv` are keyed by **content**:
 *   nix-direnv `touch -h`es its gcroot symlinks and its `flake-profile-*.rc` on
 *   every hot run, so a metadata key would never hit for the workspaces that
 *   need the cache, while a rebuilt dev shell rewrites those same paths with new
 *   `export PATH=…` lines, so content has to be in the key.
 * - Everything else is keyed by `path:kind:mtime:size`. Reading a FIFO or a
 *   device could block, so non-regular files keep their metadata.
 */

import path from 'node:path'

import { CONFIG_ENV_KEYS, baseEnv, hashString } from './deps.ts'
import { errorCode } from './errors.ts'
import { findEnvrc, readText } from './envrc.ts'
import { isDirenvCachePath } from './watches.ts'
import type { DirenvBaseEnv, EvaluatorDeps, Watch } from '../types.ts'

/** What the memo key may take from a previous conclusion: its watches and its RC path. */
export interface MemoInput {
  envrcPath: string | null
  watches: Watch[] | null
}

export interface FingerprinterOptions {
  deps: EvaluatorDeps
  /** Explicit binary from the config; `null` resolves `direnv` through `PATH`. */
  direnvPath: string | null
}

export interface Fingerprinter {
  /** Compute the memo key for `dir`; `previous` contributes the watches to re-scan. */
  memoKey(dir: string, previous: MemoInput | null): Promise<string>
  /** The direnv binary to run, cached per `PATH` string (the binary only depends on it). */
  resolveBinary(base: DirenvBaseEnv): Promise<string>
}

export function createFingerprinter(options: FingerprinterOptions): Fingerprinter {
  const { deps, direnvPath } = options
  let binaryCache: { pathKey: string | null; value: string | null } = { pathKey: null, value: null }
  const hash = (value: string): string => hashString(deps, value)

  /** `path:exists:mtime:size` — the cheapest faithful fingerprint of a file. */
  async function fileFingerprint(target: string): Promise<string> {
    let st
    try {
      st = await deps.stat(target)
    } catch (error) {
      return `${target}:-:${errorCode(error) ?? 'ERR'}`
    }
    const kind = st.isDirectory() ? 'd' : 'f'
    return `${target}:${kind}:${st.mtimeMs ?? 0}:${st.size ?? 0}`
  }

  /**
   * `path:sha:<hash>` — content, not metadata. Directories have no content, so
   * their sorted entry list stands in: a touch inside changes no name, adding or
   * removing one does.
   */
  async function contentFingerprint(target: string): Promise<string> {
    let st
    try {
      st = await deps.stat(target)
    } catch (error) {
      return `${target}:-:${errorCode(error) ?? 'ERR'}`
    }
    if (typeof st.isDirectory === 'function' && st.isDirectory()) {
      let names: string[] = []
      try {
        names = (await deps.readdir(target)).slice().sort()
      } catch {
        names = []
      }
      return `${target}:dir:[${names.join(',')}]`
    }
    if (typeof st.isFile === 'function' && !st.isFile()) {
      return `${target}:other:${st.mtimeMs ?? 0}:${st.size ?? 0}`
    }
    const read = await readText(deps, target)
    if (!read.ok) return `${target}:unreadable:${read.code}`
    return `${target}:sha:${hash(read.content)}`
  }

  function configDirOf(base: DirenvBaseEnv): string | null {
    if (base.DIRENV_CONFIG) return base.DIRENV_CONFIG
    const xdg = base.XDG_CONFIG_HOME
    if (xdg) return path.join(xdg, 'direnv')
    const home = base.HOME || ''
    return home ? path.join(home, '.config', 'direnv') : null
  }

  function dataDirOf(base: DirenvBaseEnv): string | null {
    if (base.XDG_DATA_HOME) return path.join(base.XDG_DATA_HOME, 'direnv')
    const home = base.HOME || ''
    return home ? path.join(home, '.local', 'share', 'direnv') : null
  }

  async function dirFingerprint(target: string | null): Promise<string> {
    if (!target) return 'none'
    let names: string[] = []
    try {
      const entries = await deps.readdir(target)
      names = entries.slice().sort()
    } catch {
      names = []
    }
    return `${target}:[${names.join(',')}]:${await fileFingerprint(target)}`
  }

  /** `lib/*.sh` files actually sourced by direnv, by name + content. */
  async function libFingerprint(libDir: string | null): Promise<string> {
    if (!libDir) return ''
    let names: string[] = []
    try {
      const entries = await deps.readdir(libDir)
      names = entries.filter((name) => name.endsWith('.sh')).sort()
    } catch {
      return `${libDir}:none`
    }
    const parts = [libDir]
    for (const name of names) parts.push(`${name}=${await contentFingerprint(path.join(libDir, name))}`)
    return parts.join('|')
  }

  /** Resolve `<PATH>/direnv` the way a shell would; cached per PATH string. */
  async function resolveBinary(base: DirenvBaseEnv): Promise<string> {
    if (direnvPath !== null && direnvPath !== '') return direnvPath
    const pathValue = base.PATH ?? ''
    if (binaryCache.pathKey === pathValue && binaryCache.value !== null) return binaryCache.value
    let found: string | null = null
    for (const part of pathValue.split(':')) {
      if (!part) continue
      const candidate = path.join(part, 'direnv')
      try {
        const st = await deps.stat(candidate)
        if (st.isFile() && ((st.mode ?? 0) & 0o111) !== 0) {
          found = candidate
          break
        }
      } catch {
        /* not on this PATH entry */
      }
    }
    const value = found ?? 'direnv'
    binaryCache = { pathKey: pathValue, value }
    return value
  }

  async function binaryFingerprint(binary: string): Promise<string> {
    const real = await deps.realpath(binary).catch(() => binary)
    return `${await fileFingerprint(binary)}:${real}`
  }

  async function memoKey(dir: string, previous: MemoInput | null): Promise<string> {
    const base = baseEnv(deps)
    const parts = ['k1', `cwd=${dir}`]

    const envrc = await findEnvrc(deps, dir, previous?.envrcPath ?? null)
    parts.push(`envrc=${envrc.path}:${envrc.exists ? await contentFingerprint(envrc.path) : 'missing'}`)
    parts.push(`dotenv=${await contentFingerprint(path.join(dir, '.env'))}`)

    for (const watch of previous?.watches ?? []) {
      const fingerprint = isDirenvCachePath(watch.path, base)
        ? await contentFingerprint(watch.path)
        : await fileFingerprint(watch.path)
      parts.push(`w=${watch.path}:${fingerprint}`)
    }

    const configDir = configDirOf(base)
    const tomlPaths = new Set<string>()
    if (configDir) tomlPaths.add(path.join(configDir, 'direnv.toml'))
    if (base.HOME) tomlPaths.add(path.join(base.HOME, '.config', 'direnv', 'direnv.toml'))
    for (const toml of [...tomlPaths].sort()) parts.push(`toml=${await contentFingerprint(toml)}`)

    const dataDir = dataDirOf(base)
    parts.push(`lib=${await libFingerprint(configDir ? path.join(configDir, 'lib') : null)}`)
    parts.push(`lib=${await libFingerprint(dataDir ? path.join(dataDir, 'lib') : null)}`)

    // Allow/deny transitions (a fresh `direnv allow` on a blocked RC) must
    // invalidate: the library listing is the only cheap, exact-enough signal.
    parts.push(`allow=${await dirFingerprint(dataDir ? path.join(dataDir, 'allow') : null)}`)
    parts.push(`deny=${await dirFingerprint(dataDir ? path.join(dataDir, 'deny') : null)}`)

    parts.push(`bin=${await binaryFingerprint(await resolveBinary(base))}`)
    parts.push(`path=${hash(base.PATH ?? '')}`)
    parts.push(`cfgenv=${hash(CONFIG_ENV_KEYS.map((key) => `${key}=${base[key] ?? ''}`).join('\u0000'))}`)
    return hash(parts.join('\n'))
  }

  return { memoKey, resolveBinary }
}
