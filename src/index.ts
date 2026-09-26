/**
 * dsh-direnv — every subprocess DSH spawns inherits the direnv environment of
 * its own working directory.
 *
 * The plugin takes over the `subprocess` seam, evaluates `direnv export json`
 * per directory, and injects the resulting diff into each spawn. Three
 * independent flows share that one fact source: the injector never waits, the
 * tool gate waits only for the first call, and the sidebar reads a snapshot.
 */

import { createEvaluator } from './evaluator/index.ts'
import { createGate } from './gate.ts'
import { createNoticeTracker } from './notice.ts'
import { assertPublishedRuntime, createRuntimeClass, resolveLocalSubprocessRuntime } from './runtime.ts'
import { registerStatusRoute } from './status-route.ts'
import type {
  AgentSlice,
  LoggerLike,
  LogFn,
  LogLevel,
  PluginContext,
  PreStepDecision,
  Settings,
} from './types.ts'

const PLUGIN_NAME = 'dsh-direnv'
const PLUGIN_VERSION = '0.1.0'
const LLM_PACKAGE = '@deepseek-ai/dsh-llm'
const MAX_TRACKED_SESSIONS = 512

/**
 * The schema library is a plain dependency, so it resolves next to this package
 * in every install shape — except when the plugin is loaded from outside a
 * profile, where a bare import would abort the whole entry without saying why.
 * Losing validation is survivable; losing the plugin is not.
 */
const z = await import('@deepseek-ai/schemastery')
  .then((mod) => mod.default)
  .catch(() => undefined)

export const name = PLUGIN_NAME

export const Config =
  z === undefined
    ? undefined
    : z.object({
        enabled: z.boolean().default(true),
        direnvPath: z.string().default(''),
        loadTimeoutMs: z.number().default(300_000),
        evaluateTimeoutMs: z.number().default(0),
        gateTools: z.union([z.const('all'), z.const('spawning'), z.const('none')]).default('all'),
        injectSensitive: z.union([z.const('all'), z.const('filter')]).default('all'),
        notifyModel: z.boolean().default(true),
        sidebar: z.boolean().default(true),
        disabledDirs: z.array(z.string()).default([]),
      })

const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  direnvPath: '',
  loadTimeoutMs: 300_000,
  evaluateTimeoutMs: 0,
  gateTools: 'all',
  injectSensitive: 'all',
  notifyModel: true,
  sidebar: true,
  disabledDirs: [],
}

interface PendingNotice {
  text: string
  digest: string
  attempts: number
}

interface UserMessageFactory {
  (input: { content: { type: 'text'; text: string }[]; source: { kind: string; digest: string } }): unknown
}

/** The host loader hands back a module object, so the factory is found by shape. */
function isUserMessageFactory(value: unknown): value is UserMessageFactory {
  return typeof value === 'function'
}

function createLogger(ctx: PluginContext): LogFn {
  return (level: LogLevel, message: string, extra?: object): void => {
    const line = `[${PLUGIN_NAME}] ${message}`
    try {
      const logger: LoggerLike = ctx.logger ?? console
      const sink = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.debug
      const emit = typeof sink === 'function' ? sink : logger.info
      emit?.call(logger, line, extra ?? '')
    } catch {
      /* a logger that throws must not take the plugin down */
    }
  }
}

function sessionKeyOf(agent: AgentSlice | undefined): string | undefined {
  return agent?.session?.sessionId ?? agent?.session?.id ?? agent?.id
}

function sessionCwdOf(agent: AgentSlice | undefined): string | undefined {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  while (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
  }
}

async function resolveUserMessageFactory(ctx: PluginContext, log: LogFn): Promise<UserMessageFactory | undefined> {
  try {
    const mod = await ctx.loader?.import?.(LLM_PACKAGE)
    const factory: unknown = typeof mod === 'object' && mod !== null ? Reflect.get(mod, 'createUserMessage') : undefined
    if (isUserMessageFactory(factory)) return factory
    log('warn', 'host loader returned no createUserMessage; model notices are disabled')
  } catch (error) {
    log('warn', 'cannot resolve the message factory; model notices are disabled', { error })
  }
  return undefined
}

export async function apply(ctx: PluginContext, config?: Partial<Settings>): Promise<void> {
  const log = createLogger(ctx)
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(config ?? {}) }
  if (settings.enabled === false) {
    log('info', 'disabled by configuration; leaving the stock subprocess provider in place')
    return
  }
  if (settings.gateTools === 'spawning') {
    log('warn', 'gateTools "spawning" is not implemented yet and behaves like "all"')
  }

  const evaluator = createEvaluator({
    direnvPath: settings.direnvPath === '' ? undefined : settings.direnvPath,
    evaluateTimeoutMs: settings.evaluateTimeoutMs,
    memo: true,
    log,
    isDirDisabled: (dir) => (settings.disabledDirs ?? []).includes(dir),
  })
  const gate = createGate({ evaluator, log, timeoutMs: settings.loadTimeoutMs })
  const notices = createNoticeTracker()
  const sessionDirs = new Map<string, string>()
  const pendingNotices = new Map<string, PendingNotice>()

  const Base = await resolveLocalSubprocessRuntime(ctx)
  const { Runtime } = createRuntimeClass(Base, { evaluator, config: settings, log })
  new Runtime(ctx, settings)
  assertPublishedRuntime(ctx, Runtime, log)

  const statusFor = (key: string | undefined, dir: string): void => {
    const status = evaluator.status(dir)
    if (settings.notifyModel === false || key === undefined) return
    const message = notices.observe(key, status)
    if (message !== null) remember(pendingNotices, key, { ...message, attempts: 0 })
  }

  ctx.on('agent/created', ({ agent }) => {
    const key = sessionKeyOf(agent)
    const dir = sessionCwdOf(agent)
    if (key === undefined || dir === undefined) return
    remember(sessionDirs, key, dir)
    if (settings.gateTools === 'none') return
    gate.arm(key, dir)
    void evaluator
      .prewarm(dir)
      .then(() => {
        statusFor(key, dir)
      })
      .catch(() => {})
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const agent = exec?.agent
      const key = sessionKeyOf(agent)
      const dir = sessionCwdOf(agent)
      if (agent !== undefined && key !== undefined && dir !== undefined) {
        remember(sessionDirs, key, dir)
        if (settings.gateTools !== 'none') {
          gate.arm(key, dir)
          await gate.waitFor(key, exec.signal)
        }
      }
      if (key !== undefined && dir !== undefined) statusFor(key, dir)
    } catch (error) {
      log('warn', 'tool gate failed; releasing the call', { error })
    }
    return next()
  })

  if (settings.notifyModel !== false) {
    const createUserMessage = await resolveUserMessageFactory(ctx, log)
    if (createUserMessage !== undefined) {
      ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
        const decision: PreStepDecision | undefined = await next()
        try {
          if (decision === undefined || decision.kind === 'reject') return decision
          const key = sessionKeyOf(agent)
          if (key === undefined) return decision
          const pending = pendingNotices.get(key)
          if (pending === undefined) return decision
          const message = createUserMessage({
            content: [{ type: 'text', text: pending.text }],
            source: { kind: PLUGIN_NAME, digest: pending.digest },
          })
          // Only the first step can lack an anchor — nothing has been claimed yet,
          // so the inbox is the one place a notice can wait for its claim. Every
          // later step is already running, and splicing there avoids asking the
          // loop for an extra step (which would show up as a second answer).
          if (step === 1 && decision.messages.length === 0) {
            if (typeof agent.inbox?.prepend !== 'function') {
              pending.attempts += 1
              if (pending.attempts < 3) return decision
              pendingNotices.delete(key)
              log('warn', 'could not queue the direnv notice into the inbox')
              return decision
            }
            agent.inbox.prepend('next-step', message)
            pendingNotices.delete(key)
            return decision
          }
          pendingNotices.delete(key)
          const claimed = decision.messages.findLastIndex((entry) => messages.includes(entry))
          return { ...decision, messages: decision.messages.toSpliced(claimed + 1, 0, message) }
        } catch (error) {
          log('warn', 'could not deliver the direnv notice for this step', { error, signal: signal?.aborted })
          return decision
        }
      })
    }
  }

  if (settings.sidebar !== false) {
    ctx.inject(['webServer', 'connection'], (scope) => {
      registerStatusRoute(scope, {
        evaluator,
        gate,
        config: settings,
        log,
        sessionDirs,
        plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      })
      log('info', 'sidebar status route registered')
    })
  }

  log('info', 'direnv environments are now injected per working directory', {
    loadTimeoutMs: settings.loadTimeoutMs,
    evaluateTimeoutMs: settings.evaluateTimeoutMs,
    gateTools: settings.gateTools,
  })
}
