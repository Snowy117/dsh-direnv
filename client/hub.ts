/**
 * The poll hub.
 *
 * Failure policy: every transport problem is silent and retried on the next
 * tick, because the host route may simply not be registered yet (the web carrier
 * can start after the plugin) or the deployment may not ship the host half at
 * all. Nothing here may reject into a React render.
 *
 * `values=1` is appended for one reason only: the operator expanded a row. A
 * poll that keeps asking for values would ship every secret in the workspace to
 * the browser every 1.8 seconds for a panel that is showing masks anyway.
 */

import { createBlockGuard } from './composer.ts'
import { POLL_MS, STALE_MS, STATUS_PATH } from './constants.ts'
import type { ClientContext } from './ctx.ts'
import { report } from './ctx.ts'
import { ellipsizeMiddle, firstLine, problemDigest } from './format.ts'
import type { Translate } from './messages.ts'
import type { ViewRecord } from './status-view.ts'
import { readStatusBody } from './status-view.ts'

export type NotifyFn = (level: string, text: string) => boolean

export interface StatusState {
  readonly record: ViewRecord | null
  readonly error: string | null
  readonly attempts: number
  readonly at: number | null
  readonly forcing: boolean
}

export interface RequestOutcome {
  readonly ok: boolean
  readonly error?: string | undefined
}

export interface WatchOptions {
  notify?: NotifyFn | undefined
}

export interface StatusHandle {
  snapshot(): StatusState
  subscribe(listener: () => void): () => void
  release(): void
  refresh(force?: boolean | undefined): Promise<RequestOutcome>
  notify(level: string, text: string): boolean
}

export interface StatusHub {
  watch(sessionId: string, options?: WatchOptions | undefined): StatusHandle
  peek(sessionId: string): StatusState | null
  wantsValues(sessionId: string, wanted: boolean): void
  dispose(): void
}

interface Monitor {
  sessionId: string
  refs: number
  listeners: Set<() => void>
  notify: NotifyFn | undefined
  started: boolean
  timer: number | null
  controller: AbortController | null
  lastOkAt: number
  lastDigest: string | null
  failures: number
  valuesWanted: boolean
  state: StatusState
}

const PROBLEM_KEYS: Record<string, string> = {
  blocked: 'notify.blocked',
  unreadable: 'notify.unreadable',
  'envrc-failed': 'notify.envrcFailed',
  'config-error': 'notify.configError',
  error: 'notify.error',
  'direnv-unavailable': 'notify.noDirenv',
}

/**
 * A toast is one line of text the plugin cannot wrap, so a pathological path is
 * clipped here and nowhere else: the panel itself never shortens a path in JS.
 */
const TOAST_NAME_LIMIT = 200

export function createStatusHub(ctx: ClientContext, t: Translate): StatusHub {
  const monitors = new Map<string, Monitor>()
  const blocks = createBlockGuard(ctx)
  let disposed = false
  let failuresLogged = 0

  function callNotify(monitor: Monitor, level: string, text: string): boolean {
    const notify = monitor.notify
    if (typeof notify !== 'function') return false
    try {
      return notify(level, text) === true
    } catch (error) {
      report(error)
      return false
    }
  }

  function maybeNotify(monitor: Monitor, record: ViewRecord): void {
    const key = PROBLEM_KEYS[record.state]
    if (key === undefined) {
      monitor.lastDigest = null
      return
    }
    const detail = firstLine(record.errorSummary ?? '', 120)
    const digest = problemDigest(record.state, detail)
    if (digest === monitor.lastDigest) return
    monitor.lastDigest = digest
    const name = record.envrcPath ?? record.dir
    callNotify(monitor, 'error', t(key, { name: ellipsizeMiddle(name, TOAST_NAME_LIMIT), detail: detail }))
  }

  function publish(monitor: Monitor, patch: Partial<StatusState>): void {
    monitor.state = Object.freeze({ ...monitor.state, ...patch })
    for (const listener of [...monitor.listeners]) {
      try {
        listener()
      } catch (error) {
        report(error)
      }
    }
  }

  function syncBlock(monitor: Monitor): void {
    const loading = monitor.state.record !== null && monitor.state.record.state === 'loading'
    const fresh = monitor.lastOkAt > 0 && Date.now() - monitor.lastOkAt <= STALE_MS
    if (loading && fresh) blocks.setBlock(monitor.sessionId, t('composer.loading'))
    else blocks.clearBlock(monitor.sessionId)
  }

  function request(monitor: Monitor, force: boolean): Promise<RequestOutcome> {
    if (typeof fetch !== 'function') return Promise.resolve({ ok: false, error: 'fetch unavailable' })
    const url =
      STATUS_PATH +
      '?sessionId=' +
      encodeURIComponent(monitor.sessionId) +
      (monitor.valuesWanted === true ? '&values=1' : '') +
      (force ? '&force=1' : '')
    if (monitor.controller !== null) {
      try {
        monitor.controller.abort()
      } catch {
        /* an already-settled request cannot be aborted */
      }
    }
    let controller: AbortController | null
    try {
      controller = typeof AbortController === 'function' ? new AbortController() : null
    } catch {
      controller = null
    }
    monitor.controller = controller
    if (force) publish(monitor, { forcing: true })

    return Promise.resolve()
      .then(() =>
        fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
          ...(controller === null ? {} : { signal: controller.signal }),
        }),
      )
      .then((response) => {
        if (response === undefined || response === null) throw new Error('empty response')
        const status = typeof response.status === 'number' ? response.status : 0
        if (response.ok !== true) throw new Error(`HTTP ${status}`)
        const contentType =
          response.headers !== undefined && response.headers !== null && typeof response.headers.get === 'function'
            ? String(response.headers.get('content-type') ?? '')
            : ''
        // The web carrier answers unknown paths with the SPA document, so a 200
        // is not proof that the host half is mounted: only JSON is.
        if (contentType !== '' && contentType.indexOf('json') === -1) throw new Error(`not JSON (${contentType})`)
        const body: Promise<unknown> = response.json()
        return body
      })
      .then((payload) => {
        if (monitor.controller !== controller) return { ok: false, error: 'superseded' }
        const answer = readStatusBody(payload)
        if (answer === null) throw new Error('unexpected payload shape')
        monitor.lastOkAt = Date.now()
        monitor.failures = 0
        publish(monitor, {
          record: answer.record,
          error: null,
          attempts: 0,
          at: monitor.lastOkAt,
          forcing: false,
        })
        syncBlock(monitor)
        if (answer.record === null) monitor.lastDigest = null
        else maybeNotify(monitor, answer.record)
        return { ok: true }
      })
      .catch((error: unknown) => {
        if (monitor.controller !== controller) return { ok: false, error: 'superseded' }
        const message = error instanceof Error ? error.message : String(error)
        monitor.failures += 1
        publish(monitor, { error: message, attempts: monitor.failures, forcing: false })
        const fresh = monitor.lastOkAt > 0 && Date.now() - monitor.lastOkAt <= STALE_MS
        if (!fresh) blocks.clearBlock(monitor.sessionId)
        failuresLogged += 1
        if (monitor.failures === 1 || failuresLogged % 25 === 0) {
          try {
            console.debug('[dsh-direnv] status route unavailable:', message)
          } catch {
            /* not critical */
          }
        }
        return { ok: false, error: message }
      })
      .then((outcome) => {
        if (monitor.controller === controller) monitor.controller = null
        return outcome
      })
  }

  function tick(monitor: Monitor): void {
    if (disposed) return
    // Page visibility only: a backgrounded tab stops polling, but the last answer
    // stays on screen and the poll resumes the moment the tab is shown again.
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    } catch {
      /* an exotic document object must not stop polling */
    }
    void request(monitor, false)
  }

  function start(monitor: Monitor): void {
    if (monitor.started) return
    monitor.started = true
    tick(monitor)
    monitor.timer = setInterval(() => tick(monitor), POLL_MS)
  }

  function stop(monitor: Monitor): void {
    monitor.started = false
    if (monitor.timer !== null) {
      clearInterval(monitor.timer)
      monitor.timer = null
    }
    if (monitor.controller !== null) {
      try {
        monitor.controller.abort()
      } catch {
        /* already settled */
      }
      monitor.controller = null
    }
    blocks.clearBlock(monitor.sessionId)
    monitors.delete(monitor.sessionId)
  }

  function monitorFor(sessionId: string): Monitor {
    const key = String(sessionId)
    const existing = monitors.get(key)
    if (existing !== undefined) return existing
    const monitor: Monitor = {
      sessionId: key,
      refs: 0,
      listeners: new Set(),
      notify: undefined,
      started: false,
      timer: null,
      controller: null,
      lastOkAt: 0,
      lastDigest: null,
      failures: 0,
      valuesWanted: false,
      state: Object.freeze({
        record: null,
        error: null,
        attempts: 0,
        at: null,
        forcing: false,
      }),
    }
    monitors.set(key, monitor)
    return monitor
  }

  function release(monitor: Monitor): void {
    monitor.refs -= 1
    if (monitor.refs <= 0) stop(monitor)
  }

  return {
    /**
     * Observe one session. Repeated observers share the poll; the newest
     * notifier wins, and the composer hook is the one that supplies it.
     */
    watch(sessionId: string, options?: WatchOptions | undefined): StatusHandle {
      const monitor = monitorFor(sessionId)
      monitor.refs += 1
      if (options !== undefined && options !== null && typeof options.notify === 'function') {
        monitor.notify = options.notify
      }
      start(monitor)
      return {
        snapshot: () => monitor.state,
        subscribe(listener: () => void) {
          monitor.listeners.add(listener)
          return () => {
            monitor.listeners.delete(listener)
          }
        },
        release: () => release(monitor),
        refresh: (force?: boolean | undefined) => request(monitor, force === true),
        notify: (level: string, text: string) => callNotify(monitor, level, text),
      }
    },
    peek(sessionId: string): StatusState | null {
      const monitor = monitors.get(String(sessionId))
      return monitor === undefined ? null : monitor.state
    },
    wantsValues(sessionId: string, wanted: boolean): void {
      const monitor = monitors.get(String(sessionId))
      if (monitor === undefined) return
      const next = wanted === true
      if (next === monitor.valuesWanted) return
      monitor.valuesWanted = next
      if (next) void request(monitor, false)
    },
    dispose(): void {
      disposed = true
      for (const monitor of [...monitors.values()]) {
        monitor.refs = 0
        stop(monitor)
      }
      monitors.clear()
    },
  }
}
