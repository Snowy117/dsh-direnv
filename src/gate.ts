/**
 * Holds tool calls until the session's direnv environment has a determinate
 * answer.
 *
 * The gate is a delay, never a filter: a determinate result, the timeout, and
 * the caller's abort all release it, because a harness that stops running tools
 * is worse than one that runs them with a stale environment. It arms once per
 * session — the first tool call in a workspace is the one the user is waiting
 * on; later directory changes are the spawn path's business and are injected
 * per-spawn without gating.
 */

import type { Evaluator, LogFn } from './types.ts'

const DEFAULT_TIMEOUT_MS = 300_000

/**
 * What a waiting tool call learns. `ready` covers both a real conclusion and a
 * failed evaluation: the gate delays, it does not judge, so a direnv failure
 * releases the call with the environment the caller already had.
 */
export type GateResult = 'ready' | 'timeout' | 'aborted' | 'skipped'

/**
 * `idle` = never armed (or forgotten): `waitFor` answers `ready` at once.
 * `pending` = armed, answer not in yet — the only state `describe` reports
 * today, because the record keeps its phase while `result` carries the verdict.
 */
export type GateState = 'idle' | 'pending' | 'ready' | 'skipped'

/** The gate block of the status route's envelope (`src/wire.ts`). */
export interface GateDescriptor {
  dir: string
  state: GateState
  /** Absent while the evaluation is still in flight. */
  result: GateResult | undefined
  /** Absent until the wait settles. */
  elapsedMs: number | undefined
}

export interface Gate {
  /** Idempotent per key: the first directory wins, later ones are ignored. */
  arm(key: string, dir: string): void
  waitFor(key: string, signal?: AbortSignal | undefined): Promise<GateResult>
  /** The user gave up (`/direnv skip`); `false` when the key is unknown. */
  skip(key: string): boolean
  state(key: string): GateState
  /** Diagnostics for the sidebar; `null` when the key is unknown. */
  describe(key: string): GateDescriptor | null
  forget(key: string): void
}

export interface GateDeps {
  evaluator: Evaluator
  log: LogFn
  /** The gate's own budget, i.e. the `loadTimeoutMs` setting. */
  timeoutMs?: number | undefined
}

interface GateRecord {
  key: string
  dir: string
  state: 'pending' | 'ready'
  result: GateResult | undefined
  elapsedMs: number | undefined
  resolve: (result: GateResult) => void
  promise: Promise<GateResult>
  released: Promise<GateResult>
  release: () => void
}

/**
 * A promise plus its own settle function. The `Promise` executor runs
 * synchronously, so the placeholder initializer never settles anything: the two
 * can be built in one step and passed around as a pair.
 */
function deferred(): { promise: Promise<GateResult>; settle: (result: GateResult) => void } {
  let settle: (result: GateResult) => void = () => {}
  const promise = new Promise<GateResult>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

function abortedRace(signal: AbortSignal | undefined): Promise<GateResult> | undefined {
  if (signal === undefined) return undefined
  if (signal.aborted) return Promise.resolve<GateResult>('aborted')
  return new Promise<GateResult>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      resolve('aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createGate({ evaluator, log, timeoutMs = DEFAULT_TIMEOUT_MS }: GateDeps): Gate {
  const sessions = new Map<string, GateRecord>()

  async function run(record: GateRecord): Promise<void> {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<GateResult>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout')
      }, timeoutMs)
      // A pending gate must not hold the process open when the harness exits.
      timer.unref?.()
    })
    let result: GateResult
    try {
      result = await Promise.race([
        evaluator.evaluate(record.dir).then(
          (): GateResult => 'ready',
          (error: unknown): GateResult => {
            log('warn', 'direnv evaluation failed while holding the tool gate', { error })
            return 'ready'
          },
        ),
        expired,
        record.released,
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    record.state = 'pending'
    record.elapsedMs = Date.now() - started
    record.result = result
    if (result === 'timeout') {
      log('warn', 'direnv is still loading; releasing tool calls and continuing in the background', {
        dir: record.dir,
        timeoutMs,
      })
    }
    record.resolve(result)
  }

  function arm(key: string, dir: string): void {
    const existing = sessions.get(key)
    if (existing !== undefined) return
    const entry = deferred()
    const releasedEntry = deferred()
    const record: GateRecord = {
      key,
      dir,
      state: 'pending',
      result: undefined,
      elapsedMs: undefined,
      resolve: entry.settle,
      promise: entry.promise,
      released: releasedEntry.promise,
      release: () => {
        releasedEntry.settle('skipped')
      },
    }
    sessions.set(key, record)
    void run(record)
  }

  return {
    arm,
    async waitFor(key: string, signal?: AbortSignal | undefined): Promise<GateResult> {
      const record = sessions.get(key)
      if (record === undefined) return 'ready'
      const aborted = abortedRace(signal)
      return aborted === undefined ? record.promise : Promise.race([record.promise, aborted])
    },
    skip(key: string): boolean {
      const record = sessions.get(key)
      if (record === undefined) return false
      record.release()
      return true
    },
    state(key: string): GateState {
      const record = sessions.get(key)
      if (record === undefined) return 'idle'
      return record.result === 'skipped' ? 'skipped' : record.state
    },
    describe(key: string): GateDescriptor | null {
      const record = sessions.get(key)
      if (record === undefined) return null
      return { dir: record.dir, state: record.state, result: record.result, elapsedMs: record.elapsedMs }
    },
    forget(key: string): void {
      sessions.delete(key)
    },
  }
}
