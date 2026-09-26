/**
 * Owns the `subprocess` service by subclassing the stock runtime, so that every
 * spawn spec carries the direnv environment of its own working directory.
 *
 * Two invariants shape this file: `spawn` is synchronous and must never wait on
 * an evaluation, and no failure in here may change what a child process does
 * beyond the environment variables it receives.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

import type { EnvOverlay, Evaluator, InjectSensitive, LogFn, PluginContext, Settings } from './types.ts'

const RUNTIME_PACKAGE = '@deepseek-ai/dsh-subprocess-local'

/**
 * The stock class this plugin subclasses, as a value that arrived as `unknown`.
 *
 * Its real constructor is declared `(ctx: Context)`, but the class is only ever
 * reached by dynamic resolution, so the seam's own signature names the slice of
 * the context it forwards — every cordis plugin context satisfies it, and this
 * is the only place the two have to agree.
 */
export type RuntimeCtor = new (ctx: PluginContext, config?: unknown) => LocalSubprocessRuntime

export interface RuntimeClass {
  new (ctx: PluginContext, config?: unknown): LocalSubprocessRuntime
  readonly prototype: LocalSubprocessRuntime
}

export interface RuntimeStats {
  spawns: number
  terminals: number
  injected: number
  filtered: number
  failed: number
}

export interface RuntimeDeps {
  evaluator: Evaluator
  config: Partial<Settings>
  log: LogFn
}

/**
 * The resolution itself is the only validation possible here: a module export is
 * either a function (something `extends` can try) or it is not. A value that
 * passes this check but is not really a class throws at class-definition time,
 * loudly, which is the behaviour the plain-JavaScript version had.
 */
function isRuntimeCtor(value: unknown): value is RuntimeCtor {
  return typeof value === 'function'
}

/** Read one property off a value of unknown shape without widening it to `any`. */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, key)
}

function pickRuntimeClass(mod: unknown): RuntimeCtor | undefined {
  const named = property(mod, 'LocalSubprocessRuntime')
  if (isRuntimeCtor(named)) return named
  const nested = property(property(mod, 'default'), 'LocalSubprocessRuntime')
  if (isRuntimeCtor(nested)) return nested
  const fallback = property(mod, 'default')
  return isRuntimeCtor(fallback) ? fallback : undefined
}

function describeModule(mod: unknown): string {
  if (mod === undefined) return 'module is undefined'
  if (mod === null || typeof mod !== 'object') return `module is ${typeof mod}`
  const keys = Object.keys(mod)
  return keys.length === 0 ? 'module has no exports' : `exports=[${keys.slice(0, 8).join(', ')}]`
}

/** `error.code ?? error.message ?? String(error)`, with every arm stringified. */
function reason(error: unknown): string {
  if (error === undefined || error === null) return 'unknown error'
  const code = property(error, 'code')
  if (code !== undefined && code !== null) return String(code)
  const message = property(error, 'message')
  if (message !== undefined && message !== null) return String(message)
  return String(error)
}

/**
 * Resolve the stock runtime class, trying every documented route in order of
 * portability. See "How the DSH core packages are resolved" in DESIGN.md.
 */
export async function resolveLocalSubprocessRuntime(ctx: PluginContext): Promise<RuntimeCtor> {
  const attempts: string[] = []
  const tried = (route: string, detail: string): void => {
    attempts.push(`${route} → ${detail}`)
  }

  try {
    const mod = await ctx.loader?.import?.(RUNTIME_PACKAGE)
    const Runtime = pickRuntimeClass(mod)
    if (Runtime !== undefined) return Runtime
    tried('ctx.loader.import', describeModule(mod))
  } catch (error) {
    tried('ctx.loader.import', reason(error))
  }

  try {
    const dir = ctx.get('profileContext')?.dir
    if (typeof dir === 'string' && dir.length > 0) {
      const anchor = createRequire(pathToFileURL(join(dir, 'cordis.yml')))
      const mod: unknown = await import(pathToFileURL(anchor.resolve(RUNTIME_PACKAGE)).href)
      const Runtime = pickRuntimeClass(mod)
      if (Runtime !== undefined) return Runtime
      tried('profileContext anchor', describeModule(mod))
    } else {
      tried('profileContext anchor', 'profileContext.dir is unavailable')
    }
  } catch (error) {
    tried('profileContext anchor', reason(error))
  }

  try {
    const baseUrl = ctx.loader?.ctx?.baseUrl ?? ctx.loader?.baseUrl
    const internal = ctx.loader?.internal
    if (baseUrl !== undefined && typeof internal?.import === 'function') {
      const mod = await internal.import(RUNTIME_PACKAGE, baseUrl, {})
      const Runtime = pickRuntimeClass(mod)
      if (Runtime !== undefined) return Runtime
      tried('ctx.loader.internal.import', describeModule(mod))
    } else {
      tried('ctx.loader.internal.import', 'no in-tree base URL available')
    }
  } catch (error) {
    tried('ctx.loader.internal.import', reason(error))
  }

  throw Object.assign(
    new Error(`dsh-direnv could not resolve ${RUNTIME_PACKAGE}. Every route failed:\n  ${attempts.join('\n  ')}`),
    { attempts },
  )
}

/**
 * `cwd` is required by both spec types, but the seam applies no defaults and a
 * caller may still omit it, so the check stays.
 */
function dirOf(spec: { cwd?: unknown }): string | undefined {
  const cwd = spec.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * The caller's own env wins over direnv, so tombstones survive only when unopposed.
 *
 * The two spec types disagree on the element type of `env` (`NodeJS.ProcessEnv`
 * versus `Record<string, string>`); a tombstone is `undefined` in both, and the
 * provider drops those entries exactly as Node's own `spawn` does, so one merge
 * serves both.
 */
function mergeEnv<S extends { env?: EnvOverlay | undefined }>(spec: S, overlay: EnvOverlay): S {
  if (Object.keys(overlay).length === 0) return spec
  return { ...spec, env: { ...overlay, ...spec.env } }
}

/**
 * `injectSensitive: 'filter'` withholds direnv-provided variables whose names look
 * like credentials. It deliberately mirrors the harness's own name heuristic, so
 * the two views of "sensitive" agree; it cannot see values, and a `.envrc` that
 * needs those variables will half-work under it.
 */
const SENSITIVE_NAME = /KEY|PASSWORD|SECRET|TOKEN/i

/** Returns the same object when nothing is withheld, which is what `stats.filtered` keys off. */
function applySensitivity(overlay: EnvOverlay, mode: InjectSensitive | undefined): EnvOverlay {
  if (mode !== 'filter') return overlay
  const kept: EnvOverlay = {}
  for (const [name, value] of Object.entries(overlay)) {
    if (!SENSITIVE_NAME.test(name)) kept[name] = value
  }
  return kept
}

export function createRuntimeClass(
  Base: RuntimeCtor,
  { evaluator, config, log }: RuntimeDeps,
): { Runtime: RuntimeClass; stats: RuntimeStats } {
  const stats: RuntimeStats = { spawns: 0, terminals: 0, injected: 0, filtered: 0, failed: 0 }

  class DirenvSubprocessRuntime extends Base {
    /** Debug handle on the seat this provider took: the evaluator, the settings it obeys, and the counters. */
    declare readonly direnv: { evaluator: Evaluator; config: Partial<Settings>; stats: RuntimeStats; log: LogFn }

    constructor(ctx: PluginContext, innerConfig?: unknown) {
      super(ctx, innerConfig)
      this.direnv = { evaluator, config, stats, log }
    }

    private keepSensitive(overlay: EnvOverlay): EnvOverlay {
      const kept = applySensitivity(overlay, config?.injectSensitive)
      if (kept !== overlay) stats.filtered += Object.keys(overlay).length - Object.keys(kept).length
      return kept
    }

    private overlayFor(dir: string): EnvOverlay | undefined {
      const overlay = evaluator.peekEnv(dir)
      return overlay === undefined ? undefined : this.keepSensitive(overlay)
    }

    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      stats.spawns += 1
      let merged: SubprocessSpawnSpec = spec
      try {
        const dir = dirOf(spec)
        const overlay = dir === undefined ? undefined : this.overlayFor(dir)
        if (overlay === undefined) {
          // Deferred: `prewarm` starts its work synchronously, so calling it here
          // would put the first `stat` inside the caller's spawn.
          if (dir !== undefined) queueMicrotask(() => void evaluator.prewarm(dir))
        } else {
          merged = mergeEnv(spec, overlay)
          if (merged !== spec) stats.injected += 1
        }
      } catch (error) {
        stats.failed += 1
        log('warn', 'direnv overlay lookup failed; spawning with the original environment', { error })
      }
      return super.spawn(merged)
    }

    override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
      stats.terminals += 1
      let merged: SubprocessTerminalSpawnSpec = spec
      try {
        const dir = dirOf(spec)
        if (dir !== undefined) {
          const overlay = await evaluator.ensureEnv(dir, { signal: spec?.signal })
          if (overlay !== undefined) {
            merged = mergeEnv(spec, this.keepSensitive(overlay))
            if (merged !== spec) stats.injected += 1
          }
        }
      } catch (error) {
        stats.failed += 1
        log('warn', 'direnv overlay lookup failed; opening the terminal with the original environment', {
          error,
        })
      }
      return super.spawnTerminal(merged)
    }
  }

  return { Runtime: DirenvSubprocessRuntime, stats }
}

/**
 * `ctx.subprocess` is a cordis traceable proxy: `constructor.name` and method
 * identity both lie, so only prototype identity, `instanceof`, and observed
 * behaviour prove that our provider won the seat. Losing it is silent, which is
 * why a mismatch is reported as an error rather than ignored.
 */
export function assertPublishedRuntime(
  ctx: { get(name: string): unknown },
  Runtime: RuntimeClass,
  log: LogFn,
): boolean {
  const live = ctx.get('subprocess')
  if (live === undefined) {
    log('error', 'subprocess service is missing after registration; commands will not see direnv environments')
    return false
  }
  const prototypeMatches = Object.getPrototypeOf(live) === Runtime.prototype
  const instanceMatches = live instanceof Runtime
  if (!prototypeMatches || !instanceMatches) {
    log('error', 'another subprocess provider won the seat; direnv environments will NOT be injected', {
      prototypeMatches,
      instanceMatches,
    })
    return false
  }
  return true
}
