/**
 * The direnv child: one process group, two pipes, and three ways to end early.
 *
 * The failure modes owned here are about the *process*, not about direnv's
 * output: the output ceiling, the kill deadline, `AbortSignal`, and the
 * process-group kill that takes down the bash the RC is sourced in together with
 * anything that bash started. `direnv` is spawned with `node:child_process`
 * directly — never through `ctx.subprocess`, which is the very service this
 * plugin replaces.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import type { SpawnDirenvOptions, SpawnDirenvResult } from '../types.ts'

/**
 * Kill deadline for the evaluation child; `0` means "never kill".
 *
 * No deadline by default: a cold `use flake` / `use nix` build has no bounded
 * duration (measured cold start ≈ 4.3 s, a first-time dev-shell build can take
 * minutes), and killing it both loses the work and turns the record into a
 * transient failure that retries forever without converging. The price is a
 * non-terminating `.envrc` (`sleep infinity`, a stuck fetch): it leaves one
 * `direnv` child per directory alive for the life of the host process. That is
 * bounded by the in-flight dedup (one evaluation per directory), the output
 * ceiling, and `signal`; the tool gate still releases at `loadTimeoutMs`, and a
 * finite `evaluateTimeoutMs` bounds the child's life.
 */
export const DEFAULT_EVALUATE_TIMEOUT_MS = 0

/** Real dev shells emit 10–15 KB; 4 MB is the "must survive 1 MB" headroom. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** `detached` + negative-pid kills are POSIX semantics; Windows degrades to
 *  spawning without a group and killing the single child. */
const USE_PROCESS_GROUP = process.platform !== 'win32'

/**
 * SIGKILL the child's whole process group when the platform has one, so the
 * `.envrc`'s bash and its grandchildren die with direnv. Never throws: a group
 * that is already gone (ESRCH) or that refuses the signal (EPERM) falls back to
 * the single pid, and even that failure must not stop the caller from settling.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return
  if (USE_PROCESS_GROUP) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      /* no such group (already reaped) — fall through to the single pid */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * Spawn direnv with stdio `ignore/pipe/pipe`, collect both streams, and honour
 * `signal` / `timeoutMs` / `maxBuffer`. Resolves with the raw result — the
 * caller classifies; only spawn failures reject (with `error.code` intact).
 *
 * The child is a POSIX process-group leader (`detached: true`) so that killing
 * it takes down the bash it sources the `.envrc` in, plus anything that bash
 * spawned. Windows spawns it normally and falls back to a single-pid kill.
 */
export function defaultSpawnDirenv(
  file: string,
  args: readonly string[],
  runOptions: SpawnDirenvOptions,
): Promise<SpawnDirenvResult> {
  const { cwd, env, signal, timeoutMs, maxBuffer } = runOptions
  return new Promise((resolve, reject) => {
    const state = { settled: false, aborted: false, timedOut: false, overflow: false }
    let child: ChildProcess
    try {
      child = spawn(file, [...args], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: USE_PROCESS_GROUP,
      })
    } catch (error) {
      reject(error)
      return
    }

    const out: string[] = []
    const errOut: string[] = []
    let outBytes = 0
    let errBytes = 0
    let timer: NodeJS.Timeout | null = null
    let settleTimer: NodeJS.Timeout | null = null

    const finish = (code: number | null, signalName: NodeJS.Signals | null) => {
      if (state.settled) return
      state.settled = true
      if (timer !== null) clearTimeout(timer)
      if (settleTimer !== null) clearTimeout(settleTimer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      resolve({
        exitCode: typeof code === 'number' ? code : null,
        stdout: out.join(''),
        stderr: errOut.join(''),
        aborted: state.aborted,
        timedOut: state.timedOut,
        overflow: state.overflow,
        signal: signalName ?? null,
      })
    }

    // Killing `direnv` alone does not kill the bash it spawned: a `sleep` or a
    // nix build keeps the pipes open, and `close` would only fire when it
    // finishes. Kill the whole group, drop our pipe ends and settle, so a
    // timeout or an abort returns at once.
    const kill = () => {
      killProcessTree(child)
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (settleTimer === null) {
        settleTimer = setTimeout(() => finish(null, null), 50)
        if (typeof settleTimer.unref === 'function') settleTimer.unref()
      }
    }

    const onAbort = () => {
      state.aborted = true
      kill()
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        state.timedOut = true
        kill()
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > maxBuffer) {
        state.overflow = true
        kill()
        return
      }
      out.push(chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length
      if (errBytes > maxBuffer) {
        state.overflow = true
        kill()
        return
      }
      errOut.push(chunk.toString('utf8'))
    })
    child.on('error', (error: Error) => {
      if (state.settled) return
      state.settled = true
      if (timer !== null) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code, signalName) => finish(code, signalName))

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
