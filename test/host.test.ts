import test from 'node:test'
import assert from 'node:assert/strict'

import type { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

import { createGate } from '../src/gate.ts'
import { createNoticeTracker } from '../src/notice.ts'
import { assertPublishedRuntime, createRuntimeClass } from '../src/runtime.ts'
import type { RuntimeClass, RuntimeCtor, RuntimeStats } from '../src/runtime.ts'
import type {
  EnvOverlay,
  Evaluator,
  LogFn,
  Outcome,
  PluginContext,
  Settings,
  StatusRecord,
} from '../src/types.ts'

const quiet: LogFn = () => {}

interface FakeEvaluatorState {
  prewarmed: string[]
  peeked: string[]
  evaluated: string[]
}

interface FakeEvaluatorOptions {
  env?: Record<string, EnvOverlay>
  delayMs?: number
  fail?: boolean
}

/** The evaluator double plus the call log the tests assert on. */
type FakeEvaluator = Evaluator & { state: FakeEvaluatorState }

function fakeEvaluator({ env = {}, delayMs = 0, fail = false }: FakeEvaluatorOptions = {}): FakeEvaluator {
  const state: FakeEvaluatorState = { prewarmed: [], peeked: [], evaluated: [] }
  return {
    state,
    peekEnv(dir) {
      state.peeked.push(dir)
      return env[dir]
    },
    async ensureEnv(dir) {
      state.evaluated.push(dir)
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (fail) throw new Error('evaluator blew up')
      return env[dir]
    },
    async evaluate(dir): Promise<Outcome> {
      state.evaluated.push(dir)
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (fail) throw new Error('evaluator blew up')
      return {
        kind: 'ok',
        dir,
        at: Date.now(),
        ms: 0,
        envrcPath: null,
        overlay: {},
        env: {},
        warnings: [],
        degraded: false,
        watches: null,
        memoHit: false,
      }
    },
    prewarm(dir) {
      state.prewarmed.push(dir)
      return Promise.resolve()
    },
    invalidate() {},
    status(dir): StatusRecord {
      return {
        dir,
        state: 'idle',
        at: null,
        ms: null,
        envrcPath: null,
        memoHit: false,
        variables: [],
        pathEntries: [],
        credentials: [],
        errorSummary: null,
        warnings: [],
        watchCount: 0,
        env: null,
      }
    },
    inFlight() {
      return []
    },
  }
}

/**
 * The spawn spec slice this file reads back. It is deliberately smaller than
 * `SubprocessSpawnSpec`: two cases here forward a spec with no `cwd` at all, and
 * the plugin's overrides are the only code under test.
 */
interface SpawnSpecLike {
  argv: readonly string[]
  cwd?: string | undefined
  env?: Record<string, string | undefined> | undefined
}

interface RecordedSpawn {
  kind: 'spawn'
  spec: SpawnSpecLike
}

interface RecordedTerminal {
  kind: 'spawnTerminal'
  spec: SpawnSpecLike
}

class FakeRuntime {
  readonly ctx: PluginContext
  readonly specs: SpawnSpecLike[]

  constructor(ctx: PluginContext) {
    this.ctx = ctx
    this.specs = []
  }

  spawn(spec: SpawnSpecLike): RecordedSpawn {
    this.specs.push(spec)
    return { kind: 'spawn', spec }
  }

  async spawnTerminal(spec: SpawnSpecLike): Promise<RecordedTerminal> {
    this.specs.push(spec)
    return { kind: 'spawnTerminal', spec }
  }
}

/**
 * `RuntimeCtor` names the stock `LocalSubprocessRuntime` — private fields and all —
 * which no stand-in can satisfy structurally, and substituting the base is the
 * whole point of this file, so the seam is asserted once here.
 */
const FAKE_BASE = FakeRuntime as unknown as RuntimeCtor

/** The base constructor only stores its context; the built class is typed with the real one. */
const FAKE_CTX = {} as unknown as PluginContext

/**
 * The object `createRuntimeClass` builds really is the fake base plus the plugin's
 * two overrides, so the recorder is reached by narrowing rather than by widening
 * what the class claims to be.
 */
function fakeRuntime(runtime: LocalSubprocessRuntime): FakeRuntime {
  assert.ok(runtime instanceof FakeRuntime, 'the built runtime must extend the fake base')
  return runtime
}

interface Built {
  runtime: FakeRuntime
  stats: RuntimeStats
  evaluator: FakeEvaluator
}

function build(env: Record<string, EnvOverlay>, config: Partial<Settings> = {}): Built {
  const evaluator = fakeEvaluator({ env })
  const { Runtime, stats } = createRuntimeClass(FAKE_BASE, { evaluator, config, log: quiet })
  const runtime = new Runtime(FAKE_CTX)
  return { runtime: fakeRuntime(runtime), stats, evaluator }
}

test('spawn injects the overlay of its own cwd and lets the caller win', () => {
  const { runtime, stats } = build({ '/work/a': { FOO: 'from-direnv', PATH: '/dev/bin' } })
  runtime.spawn({ argv: ['echo'], cwd: '/work/a', env: { FOO: 'from-caller' } })

  assert.deepEqual(runtime.specs[0]!.env, { FOO: 'from-caller', PATH: '/dev/bin' })
  assert.equal(stats.injected, 1)
})

test('tombstones reach the child as undefined, which the runtime filters out', () => {
  const { runtime } = build({ '/work/a': { GONE: undefined } })
  runtime.spawn({ argv: ['echo'], cwd: '/work/a' })

  assert.equal('GONE' in runtime.specs[0]!.env!, true)
  assert.equal(runtime.specs[0]!.env!.GONE, undefined)
})

test('an unknown directory is forwarded untouched and prewarmed in the background', async () => {
  const { runtime, stats, evaluator } = build({})
  const spec = { argv: ['echo'], cwd: '/work/unknown' }
  const handle = runtime.spawn(spec)

  assert.equal(runtime.specs[0], spec)
  assert.deepEqual(
    evaluator.state.prewarmed,
    [],
    'spawn must not start evaluation work inside the caller stack',
  )
  await Promise.resolve()
  assert.deepEqual(evaluator.state.prewarmed, ['/work/unknown'])
  assert.equal(stats.injected, 0)
  assert.deepEqual(handle, { kind: 'spawn', spec })
})

test('an empty overlay is not counted as an injection', () => {
  const { runtime, stats } = build({ '/work/a': {} })
  runtime.spawn({ argv: ['echo'], cwd: '/work/a' })

  assert.equal(stats.injected, 0)
  assert.equal(runtime.specs[0]!.env, undefined)
})

test('a spec without a cwd is forwarded untouched', () => {
  const { runtime, evaluator } = build({})
  runtime.spawn({ argv: ['echo'] })

  assert.deepEqual(evaluator.state.peeked, [])
  assert.deepEqual(evaluator.state.prewarmed, [])
})

test('a failing evaluator never stops the spawn', () => {
  const evaluator = fakeEvaluator({})
  evaluator.peekEnv = () => {
    throw new Error('cache exploded')
  }
  const { Runtime, stats } = createRuntimeClass(FAKE_BASE, { evaluator, config: {}, log: quiet })
  const runtime = fakeRuntime(new Runtime(FAKE_CTX))
  const spec = { argv: ['echo'], cwd: '/work/a' }
  runtime.spawn(spec)

  assert.equal(runtime.specs[0], spec)
  assert.equal(stats.failed, 1)
})

test('spawnTerminal awaits the evaluation before it builds the spec', async () => {
  const { runtime, evaluator } = build({ '/work/a': { FOO: 'late' } })
  const result = await runtime.spawnTerminal({ argv: ['bash'], cwd: '/work/a' })

  assert.deepEqual(evaluator.state.evaluated, ['/work/a'])
  assert.equal(result.spec.env!.FOO, 'late')
})

test('assertPublishedRuntime rejects a service that is not ours', () => {
  const errors: string[] = []
  const log: LogFn = (level, message) => errors.push(`${level}:${message}`)
  class Ours {}
  /** Only two unrelated classes are needed to prove the prototype/instanceof check. */
  const RuntimeClassOf = Ours as unknown as RuntimeClass
  const foreign = new (class Other {})()
  assert.equal(assertPublishedRuntime({ get: () => foreign }, RuntimeClassOf, log), false)
  assert.equal(errors.length, 1)

  const ours = new Ours()
  assert.equal(assertPublishedRuntime({ get: () => ours }, RuntimeClassOf, quiet), true)
  assert.equal(assertPublishedRuntime({ get: () => undefined }, RuntimeClassOf, log), false)
})

test('the gate releases on a determinate result', async () => {
  const evaluator = fakeEvaluator({ delayMs: 30 })
  const gate = createGate({ evaluator, log: quiet, timeoutMs: 5_000 })
  gate.arm('s1', '/work/a')

  const started = Date.now()
  assert.equal(await gate.waitFor('s1'), 'ready')
  assert.ok(Date.now() - started >= 25)
  assert.equal(gate.state('s1'), 'pending')

  const second = Date.now()
  assert.equal(await gate.waitFor('s1'), 'ready')
  assert.ok(Date.now() - second < 15, 'a settled gate must not wait again')
})

test('the gate releases on timeout and keeps evaluating in the background', async () => {
  const evaluator = fakeEvaluator({ delayMs: 120 })
  const gate = createGate({ evaluator, log: quiet, timeoutMs: 20 })
  gate.arm('s1', '/work/a')

  assert.equal(await gate.waitFor('s1'), 'timeout')
  assert.deepEqual(evaluator.state.evaluated, ['/work/a'])
})

test('the gate releases when the caller aborts or the user skips', async () => {
  const evaluator = fakeEvaluator({ delayMs: 200 })
  const gate = createGate({ evaluator, log: quiet, timeoutMs: 5_000 })

  gate.arm('s1', '/work/a')
  const controller = new AbortController()
  const waiting = gate.waitFor('s1', controller.signal)
  controller.abort()
  assert.equal(await waiting, 'aborted')

  gate.arm('s2', '/work/b')
  const skipped = gate.waitFor('s2')
  assert.equal(gate.skip('s2'), true)
  assert.equal(await skipped, 'skipped')
  assert.equal(gate.state('s2'), 'skipped')
})

test('an unarmed session never waits', async () => {
  const gate = createGate({ evaluator: fakeEvaluator({}), log: quiet })
  assert.equal(await gate.waitFor('unknown'), 'ready')
  assert.equal(gate.state('unknown'), 'idle')
  assert.equal(gate.describe('unknown'), null)
})

test('arming twice keeps the first directory, because the gate arms once per session', () => {
  const gate = createGate({ evaluator: fakeEvaluator({}), log: quiet })
  gate.arm('s1', '/work/a')
  gate.arm('s1', '/work/elsewhere')
  assert.equal(gate.describe('s1')!.dir, '/work/a')
  gate.forget('s1')
  assert.equal(gate.describe('s1'), null)
})

function statusOf(overrides: Partial<StatusRecord>): StatusRecord {
  return {
    dir: '/work/a',
    state: 'ok',
    at: 1,
    ms: 42,
    envrcPath: '/work/a/.envrc',
    memoHit: false,
    variables: [{ name: 'FOO', sensitive: false, hasValue: true }],
    pathEntries: [{ value: '/nix/store/devshell/bin', change: 'added' }],
    credentials: [],
    errorSummary: null,
    warnings: [],
    watchCount: 0,
    env: { FOO: 'bar' },
    ...overrides,
  }
}

test('the first notice is a baseline and never repeats unchanged state', () => {
  const tracker = createNoticeTracker()
  const first = tracker.observe('s1', statusOf({}))
  assert.match(first!.text, /^\[dsh-direnv\] direnv loaded \/work\/a\/\.envrc/)
  assert.match(first!.text, /1 variable/)
  assert.match(first!.text, /1 PATH entry added/)
  assert.equal(tracker.observe('s1', statusOf({})), null)
})

test('a PATH that shrinks is reported as a count, and no path component is ever quoted', () => {
  const tracker = createNoticeTracker()
  const entries: StatusRecord['pathEntries'] = [
    { value: '/nix/store/devshell/bin', change: 'added' },
    { value: '/opt/removed-one', change: 'removed' },
    { value: '/opt/removed-two', change: 'removed' },
    { value: '/usr/bin', change: 'unchanged' },
  ]
  const notice = tracker.observe('s1', statusOf({ pathEntries: entries }))
  assert.match(notice!.text, /1 PATH entry added, 2 removed/)
  assert.doesNotMatch(notice!.text, /\/opt\/removed-one|\/opt\/removed-two/)
})

test('a re-evaluation whose PATH only lost entries says so without naming them', () => {
  const tracker = createNoticeTracker()
  tracker.observe('s1', statusOf({}))
  const delta = tracker.observe(
    's1',
    statusOf({
      pathEntries: [{ value: '/nix/store/devshell/bin', change: 'removed' }],
      ms: 43,
    }),
  )
  assert.match(delta!.text, /PATH: 1 PATH entry removed/)
  assert.doesNotMatch(delta!.text, /\/nix\/store\/devshell/)
})

test('a changed variable set produces a delta naming what moved', () => {
  const tracker = createNoticeTracker()
  tracker.observe('s1', statusOf({}))
  const delta = tracker.observe(
    's1',
    statusOf({
      variables: [
        { name: 'FOO', sensitive: false, hasValue: true },
        { name: 'BAR', sensitive: false, hasValue: true },
      ],
      ms: 43,
    }),
  )
  assert.match(delta!.text, /added BAR/)
  assert.doesNotMatch(delta!.text, /removed/)
})

test('removals are reported, and credentials stay out of model-facing text', () => {
  const tracker = createNoticeTracker()
  tracker.observe('s1', statusOf({}))
  const delta = tracker.observe('s1', statusOf({ variables: [], credentials: ['API_KEY'], ms: 44 }))
  assert.match(delta!.text, /removed FOO/)
  assert.doesNotMatch(delta!.text, /API_KEY/)
})

test('a blocked workspace tells the model not to approve it itself', () => {
  const tracker = createNoticeTracker()
  const notice = tracker.observe('s1', statusOf({ state: 'blocked', envrcPath: '/work/a/.envrc', ms: 7 }))
  assert.match(notice!.text, /blocked/)
  assert.match(notice!.text, /direnv allow/)
  assert.match(notice!.text, /do not attempt to approve it yourself/)
})

test('a workspace without an .envrc still reassures the model once', () => {
  const tracker = createNoticeTracker()
  const notice = tracker.observe('s1', statusOf({ state: 'absent', envrcPath: null, variables: [], pathEntries: [] }))
  assert.match(notice!.text, /No \.envrc applies/)
  assert.equal(tracker.observe('s1', statusOf({ state: 'absent', envrcPath: null, variables: [], pathEntries: [] })), null)
})

test('a credential baseline mentions the count, never the names', () => {
  const tracker = createNoticeTracker()
  const notice = tracker.observe('s1', statusOf({ credentials: ['API_KEY', 'TOKEN'], ms: 50 }))
  assert.match(notice!.text, /2 credential-like/)
  assert.doesNotMatch(notice!.text, /API_KEY|TOKEN/)
})

test('injectSensitive defaults to injecting everything direnv provides', () => {
  const { runtime } = build({ '/work/a': { API_KEY: 'secret', PATH: '/dev/bin' } })
  runtime.spawn({ argv: ['echo'], cwd: '/work/a' })
  assert.deepEqual(runtime.specs[0]!.env, { API_KEY: 'secret', PATH: '/dev/bin' })
})

test("injectSensitive 'filter' withholds credential-like names, using the harness's own heuristic", () => {
  const { runtime, stats } = build(
    {
      '/work/a': {
        API_KEY: 'secret',
        DB_PASSWORD: 'hunter2',
        GH_TOKEN: 't',
        MY_SECRET: 's',
        MONKEY_BUSINESS: 'innocent but matching',
        PATH: '/dev/bin',
        FOO: 'plain',
      },
    },
    { injectSensitive: 'filter' },
  )
  runtime.spawn({ argv: ['echo'], cwd: '/work/a' })

  assert.deepEqual(runtime.specs[0]!.env, { PATH: '/dev/bin', FOO: 'plain' })
  assert.equal(stats.filtered, 5)
})

test("injectSensitive 'filter' applies to terminals too, and tombstones are not counted as filtered values", () => {
  const { runtime, stats } = build({ '/work/a': { FOO: undefined } }, { injectSensitive: 'filter' })
  runtime.spawn({ argv: ['echo'], cwd: '/work/a' })
  assert.equal(runtime.specs[0]!.env!.FOO, undefined)
  assert.equal(stats.filtered, 0)
})

test("injectSensitive 'filter' survives an overlay whose every entry is withheld", async () => {
  const { runtime, stats } = build({ '/work/a': { API_KEY: 'secret' } }, { injectSensitive: 'filter' })
  const result = await runtime.spawnTerminal({ argv: ['bash'], cwd: '/work/a' })
  assert.equal(result.spec.env, undefined, 'an empty filtered overlay must not rewrite the spec env')
  assert.equal(stats.filtered, 1)
})

test('a re-evaluation in flight is not reported to the model', () => {
  const tracker = createNoticeTracker()
  assert.match(tracker.observe('s1', statusOf({}))!.text, /direnv loaded/)

  assert.equal(tracker.observe('s1', statusOf({ state: 'loading' })), null, 'loading is not a conclusion')
  assert.equal(tracker.observe('s1', statusOf({ state: 'idle' })), null, 'idle is not a conclusion')

  // The ok -> loading -> ok round trip must not re-announce an unchanged workspace.
  assert.equal(tracker.observe('s1', statusOf({})), null)
})

test('the failure notice does not stutter the exit status', () => {
  const tracker = createNoticeTracker()
  const notice = tracker.observe(
    's1',
    statusOf({ state: 'envrc-failed', errorSummary: 'exit status 7', variables: [], pathEntries: [] }),
  )
  assert.doesNotMatch(notice!.text, /exit status exit status/)
  assert.match(notice!.text, /exit status 7/)
})
