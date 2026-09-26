/**
 * Shared types for dsh-direnv — the executable half of `CONTRACTS.md`.
 *
 * This file owns the vocabulary every module shares, and it states the
 * invariants that are invisible in a plain JavaScript signature: a tombstone
 * that is not "absent", an `Outcome` whose fields depend on its `kind`, a
 * `peekEnv` with three answers, a record table keyed by canonical directories.
 * Where this file and `CONTRACTS.md` disagree, the document wins and this file
 * is the bug.
 */

/**
 * direnv's env diff. `null` = delete this variable (tombstone), `string` = set,
 * a key that is not there at all = leave the variable alone.
 *
 * The tombstone is load-bearing: `direnv export json` reports a removal as an
 * explicit `null` (it diffs against the environment it was given), and dropping
 * that `null` would leave the removed variable behind in every subprocess.
 */
export type Overlay = Record<string, string | null>

/**
 * The injectable form of an `Overlay`: every `null` turned into `undefined`.
 *
 * `undefined` here is *not* sugar for "absent" — it is the tombstone, and it is
 * exactly what `{ ...envOverlay, ...spec.env }` needs in order to shadow an
 * ambient variable, since `SubprocessSpawnSpec.env` uses the same convention.
 * Values are `string`, so a key that exists always carries a value or a
 * tombstone.
 */
export type EnvOverlay = Record<string, string | undefined>

/** One path `direnv export` reported as an input of the RC (decoded `DIRENV_WATCHES`). */
export interface Watch {
  path: string
  modtime: number
  exists: boolean
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFn = (level: LogLevel, message: string, extra?: object) => void

declare const canonicalDirBrand: unique symbol

/**
 * A directory string that has been through `canonDir()` (i.e. `path.resolve`).
 *
 * The record table and the in-flight map are keyed by it. Branding it keeps a
 * raw `spec.cwd` from being used as a key by accident: two spellings of the same
 * directory (relative, trailing slash, symlink) would silently become two memo
 * entries and two concurrent direnv children for one workspace.
 */
export type CanonicalDir = string & { readonly [canonicalDirBrand]: 'canonical' }

/** Ambient environment as `deps.baseEnv()` hands it over — normally `process.env`. */
export type AmbientEnv = Record<string, string | undefined>

/**
 * The base every direnv call starts from: `AmbientEnv` after the `DIRENV_*`
 * *load state* keys are gone and every non-string value is dropped.
 *
 * `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `DIRENV_CONFIG` /
 * `DIRENV_LOG_FORMAT` deliberately survive: the first three are where the allow
 * library and nix-direnv live, and the last two are user configuration rather
 * than load state (`src/evaluator/deps.ts` owns that filter).
 */
export type DirenvBaseEnv = Record<string, string>

/**
 * The slice of `fs.Stats` the evaluator reads. Fields are optional and the
 * `is*` members are re-checked with `typeof … === 'function'` before use:
 * `stat` is an injection point, and a partial or hostile stat must degrade to a
 * probe answer instead of throwing out of the evaluator.
 */
export interface DirEntryStat {
  isDirectory(): boolean
  isFile(): boolean
  mode?: number | undefined
  mtimeMs?: number | undefined
  size?: number | undefined
}

export interface SpawnDirenvOptions {
  cwd: string
  env: DirenvBaseEnv
  /** `ignore`: a `read` in the RC must see EOF, never the harness' stdin. */
  stdin: 'ignore'
  /** Aborts the run — and its whole process group — when the caller gives up. */
  signal: AbortSignal | undefined
  /** Kill deadline; `0` = no deadline at all (see `DEFAULT_EVALUATE_TIMEOUT_MS`). */
  timeoutMs: number
  /** Per-stream byte ceiling; exceeding it kills the run and reports `overflow`. */
  maxBuffer: number
}

/**
 * Raw result of one direnv child. `aborted` / `timedOut` / `overflow` are flags
 * rather than rejections because they are *transient conclusions* the caller
 * classifies — only a failure to spawn at all rejects, with `error.code` intact.
 */
export interface SpawnDirenvResult {
  exitCode: number | null
  stdout: string
  stderr: string
  aborted?: boolean | undefined
  timedOut?: boolean | undefined
  overflow?: boolean | undefined
  signal?: string | null | undefined
}

export type SpawnDirenvFn = (
  file: string,
  args: readonly string[],
  options: SpawnDirenvOptions,
) => Promise<SpawnDirenvResult>

/**
 * Every side effect the evaluator performs, behind one injected seam.
 *
 * Production injects only `baseEnv` (a deterministic ambient environment is a
 * test concern); every other member has a real default in `src/evaluator/deps.ts`.
 * A dependency may reject or return nonsense: the evaluator classifies that as
 * an `Outcome` instead of letting it escape.
 */
export interface EvaluatorDeps {
  baseEnv(): AmbientEnv
  stat(target: string): Promise<DirEntryStat>
  /** Only ever called with `'utf8'`; a non-string answer is coerced by the caller. */
  readFile(target: string, encoding: 'utf8'): Promise<unknown>
  readdir(target: string): Promise<readonly string[]>
  access(target: string, mode: number): Promise<void>
  realpath(target: string): Promise<string>
  now(): number
  hash(value: string): string
  spawnDirenv: SpawnDirenvFn
}

export type EvaluatorDepsInput = Partial<EvaluatorDeps>

export interface EvaluatorOptions {
  /** Explicit direnv binary; empty or missing resolves `direnv` through `PATH`. */
  direnvPath?: string | undefined
  /** Kill deadline for one evaluation child; `0` (the default) = never kill. */
  evaluateTimeoutMs?: number | undefined
  /** @deprecated alias of `evaluateTimeoutMs`, kept for configuration compatibility. */
  loadTimeoutMs?: number | undefined
  /** `false` disables the memo entirely: every call really runs direnv (debugging). */
  memo?: boolean | undefined
  log?: LogFn | undefined
  isDirDisabled?: ((dir: string) => boolean) | undefined
  deps?: EvaluatorDepsInput | undefined
}

export interface EvaluateRequest {
  /** Caller gave up: the child (and its process group) is killed, nothing is recorded. */
  signal?: AbortSignal | undefined
  /** Bypass the memo and run the RC again (the sidebar's reload button). */
  force?: boolean | undefined
}

/** `prewarm` takes no signal by design: it is fire-and-forget. */
export interface PrewarmRequest {
  force?: boolean | undefined
}

/**
 * `peekEnv`'s three-valued answer — three states, not two, and therefore not
 * `EnvOverlay | undefined` written twice.
 *
 * - `InjectableEnv` — an `ok` record: merge it into the spawn spec.
 * - `NoEnv` — a *determinate* conclusion (`absent`, `blocked`, `disabled`,
 *   `unreadable`, `envrc-failed`, `config-error`, `direnv-unavailable`):
 *   "evaluated, nothing to inject". `{}` is a real answer, so `spawn()` must not
 *   prewarm this directory again.
 * - `undefined` — no record at all, or the last run was *transient* (`error`:
 *   timeout, killed, spawn failure, crash, bad JSON, output overflow):
 *   "unknown, worth retrying", so the next `spawn()` prewarms again.
 *
 * Getting the last two mixed up is the failure this plugin already paid for:
 * treating `undefined` as `{}` stops the retry a slow `use flake` needs, and
 * treating `{}` as `undefined` starts one direnv child per subprocess of a
 * blocked workspace.
 */
export type InjectableEnv = EnvOverlay
/** Exactly the empty object `peekEnv` hands back for a determinate "nothing to inject". */
export type NoEnv = Record<string, never>
export type PeekEnvResult = InjectableEnv | NoEnv | undefined

export interface Evaluator {
  /**
   * Synchronous, zero IO, copy-out. See `PeekEnvResult` for the three answers —
   * this is the hot path of every subprocess, so it may not throw: an unknown
   * directory already answers `undefined`.
   */
  peekEnv(dir: string): PeekEnvResult

  /**
   * Async: a memo hit returns at once, otherwise the directory is evaluated once
   * (same-directory in-flight dedup). Never rejects, and answers with the same
   * three states as `peekEnv`.
   */
  ensureEnv(dir: string, options?: EvaluateRequest): Promise<PeekEnvResult>

  /** Full result including status and diagnostics, for the gate and the status route. Never rejects. */
  evaluate(dir: string, options?: EvaluateRequest): Promise<Outcome>

  /** Fire-and-forget warm-up; the returned promise never rejects. */
  prewarm(dir: string, options?: PrewarmRequest): Promise<void>

  /** Drop one directory's record, or every record when called with no directory. */
  invalidate(dir?: string | null): void
  /** Pure table lookup, for the sidebar. */
  status(dir: string): StatusRecord
  /** Pure table lookup: canonical directories currently being evaluated. */
  inFlight(): readonly string[]
}

export type OutcomeKind =
  | 'ok'
  | 'absent'
  | 'unreadable'
  | 'blocked'
  | 'envrc-failed'
  | 'config-error'
  | 'error'
  | 'direnv-unavailable'
  | 'disabled'

export interface OutcomeCore {
  dir: string
  at: number
  /** Additive: present only when there is something to say. */
  warnings?: string[]
  /** Additive, and free-form on purpose (`spawn ENOENT`, `cwd-missing`, `timeout`, …). */
  reason?: string
}

/** Outcomes produced by a run that took time; `disabled` never runs anything, so it has no `ms`. */
export interface TimedOutcome extends OutcomeCore {
  ms: number
}

export interface OkOutcome extends TimedOutcome {
  kind: 'ok'
  envrcPath: string | null
  overlay: Overlay
  env: EnvOverlay
  /** Not additive here: an ok run always reports its stderr noise, possibly as `[]`. */
  warnings: string[]
  /** `true` when stderr had noise, i.e. the overlay may be incomplete. */
  degraded: boolean
  watches: Watch[] | null
  memoHit: boolean
}

/** No `.envrc` anywhere up the tree — or a readable one that produced no diff at all. */
export interface AbsentOutcome extends TimedOutcome {
  kind: 'absent'
}

export interface UnreadableOutcome extends TimedOutcome {
  kind: 'unreadable'
  envrcPath: string
}

export interface BlockedOutcome extends TimedOutcome {
  kind: 'blocked'
  envrcPath: string | null
  stderr: string
}

export interface EnvrcFailedOutcome extends TimedOutcome {
  kind: 'envrc-failed'
  /** The RC's own exit status, parsed from `direnv: error exit status N`. */
  status: number
  stderr: string
}

export interface ConfigErrorOutcome extends TimedOutcome {
  kind: 'config-error'
  stderr: string
}

/** The transient bucket: timeout, killed, spawn failure, crash, bad JSON, overflow. */
export interface ErrorOutcome extends TimedOutcome {
  kind: 'error'
  stderr: string
  exitCode: number | null
}

export interface DirenvUnavailableOutcome extends TimedOutcome {
  kind: 'direnv-unavailable'
  /** Errno-style code: `ENOENT`, `EACCES`, `ENOTDIR`. */
  code: string
}

/** `disabledDirs` matched: direnv is never consulted for this directory. */
export interface DisabledOutcome extends OutcomeCore {
  kind: 'disabled'
}

/**
 * What `evaluate` publishes: a real discriminated union, so `outcome.stderr`
 * exists only on the kinds that have stderr and `outcome.watches` only on `ok`.
 * Narrowing on `kind` narrows the remaining fields with it, which is what keeps
 * a consumer from reading a fact the run never produced.
 */
export type Outcome =
  | OkOutcome
  | AbsentOutcome
  | UnreadableOutcome
  | BlockedOutcome
  | EnvrcFailedOutcome
  | ConfigErrorOutcome
  | ErrorOutcome
  | DirenvUnavailableOutcome
  | DisabledOutcome

/** One overlay entry as the sidebar reports it: never the value itself. */
export interface StatusVariable {
  name: string
  /** Matches the harness' own `/KEY|PASSWORD|SECRET|TOKEN/i` name heuristic. */
  sensitive: boolean
  hasValue: boolean
}

/** How one `PATH` component differs from the base environment's `PATH`. */
export type PathChange = 'added' | 'removed' | 'unchanged'

/**
 * One `PATH` component as the panel shows it.
 *
 * `value` is the raw component, empty string included: an empty component is a
 * real (if pathological) `PATH` element, and rendering it is the client's call.
 */
export interface PathEntry {
  readonly value: string
  readonly change: PathChange
}

export interface DerivedFacts {
  variables: StatusVariable[]
  credentials: string[]
  /** Ordered `PATH` diff against the base PATH (see `derive.ts` for the order). */
  pathEntries: PathEntry[]
}

export interface StatusRecord {
  dir: string
  state: OutcomeKind | 'idle' | 'loading'
  at: number | null
  ms: number | null
  envrcPath: string | null
  memoHit: boolean
  variables: StatusVariable[]
  pathEntries: PathEntry[]
  credentials: string[]
  errorSummary: string | null
  warnings: string[]
  /** Watched-path count of the last evaluation (diagnostic; the panel does not show it yet). */
  watchCount: number
  /** Values are `null` unless the status route was asked with `?values=1`. */
  env: EnvOverlay | null
}

/**
 * The memo record: an `Outcome` plus the bookkeeping the evaluator needs — the
 * memo `key`, whether the kind may be reused on a key match, and the derived
 * sidebar facts.
 *
 * Not part of the published surface (`Outcome` is). It is a discriminated union
 * for the same reason `Outcome` is: a record's `kind` decides which fields
 * exist, so `publicOutcome` and `status()` cannot read a field the classified
 * run never produced.
 */
export interface RecordCore {
  /**
   * The directory this record is about, exactly as it will be published — the
   * table's key whenever the record is stored (canonical, except for the
   * never-stored `invalid-dir` error, which reports the raw input).
   */
  dir: string
  key: string
  ms: number
  at: number
  memoHit: boolean
  /** `true` when a memo-key match may reuse this conclusion (see `REUSABLE_KINDS`). */
  reusable: boolean
  warnings: string[]
  reason: string | null
  errorSummary: string | null
}

export interface OkRecord extends RecordCore {
  kind: 'ok'
  envrcPath: string | null
  overlay: Overlay
  env: EnvOverlay
  watches: Watch[] | null
  degraded: boolean
  derived: DerivedFacts | null
}

/** `absent` still carries the RC path when a readable RC produced no diff. */
export interface AbsentRecord extends RecordCore {
  kind: 'absent'
  envrcPath: string | null
}

export interface UnreadableRecord extends RecordCore {
  kind: 'unreadable'
  envrcPath: string
}

export interface BlockedRecord extends RecordCore {
  kind: 'blocked'
  envrcPath: string | null
  stderr: string
}

export interface EnvrcFailedRecord extends RecordCore {
  kind: 'envrc-failed'
  envrcPath: string | null
  status: number
  stderr: string
}

export interface ConfigErrorRecord extends RecordCore {
  kind: 'config-error'
  envrcPath: string | null
  stderr: string
}

/** The only record kind that has an `exitCode` (see `ErrorOutcome`). */
export interface ErrorRecord extends RecordCore {
  kind: 'error'
  envrcPath: string | null
  stderr: string
  exitCode: number | null
}

export interface UnavailableRecord extends RecordCore {
  kind: 'direnv-unavailable'
  /** Always null: the binary or the cwd is gone, so no RC could be found. */
  envrcPath: null
  code: string
}

/** Carries empty `overlay`/`env` so `status()` reports a directory that injects nothing. */
export interface DisabledRecord extends RecordCore {
  kind: 'disabled'
  envrcPath: null
  overlay: Overlay
  env: EnvOverlay
}

export type EvaluationRecord =
  | OkRecord
  | AbsentRecord
  | UnreadableRecord
  | BlockedRecord
  | EnvrcFailedRecord
  | ConfigErrorRecord
  | ErrorRecord
  | UnavailableRecord
  | DisabledRecord

/* ------------------------------------------------------------------------- *
 * Host integration vocabulary
 *
 * What follows describes the DSH/cordis surface the host half consumes. It is
 * written structurally on purpose: `@deepseek-ai/cordis-plugin-loader` (the
 * `loader` service), the agent/tool event payloads, and the web carrier's
 * `webServer` / `connection` services all live in packages this plugin cannot
 * depend on, and this file is imported by `src/wire.ts`, i.e. by the browser
 * half, so it may not name `node:*` or `NodeJS.*` either.
 *
 * The specs that *are* installable are used for real instead: `src/runtime.ts`
 * types its spawn seam with `SubprocessSpawnSpec` / `SubprocessTerminalSpawnSpec`
 * and the class it subclasses with `LocalSubprocessRuntime`.
 * ------------------------------------------------------------------------- */

export type LogSink = (message: string, ...args: unknown[]) => void

/** The four sink methods this plugin calls; anything may be missing. */
export interface LoggerLike {
  debug?: LogSink | undefined
  info?: LogSink | undefined
  warn?: LogSink | undefined
  error?: LogSink | undefined
}

/**
 * `ctx.loader` — only the resolution routes `src/runtime.ts` tries, in the order
 * it tries them. `internal` is Node's own module loader as the loader plugin
 * reaches it; `ctx` is the context the loader service was constructed with
 * (declared `protected` on the real class, exposed at runtime by `Service`).
 */
export interface LoaderSlice {
  import?(specifier: string, getOuterStack?: () => string[]): unknown
  baseUrl?: string | undefined
  ctx?: { baseUrl?: string | undefined } | undefined
  internal?: { import(specifier: string, parentURL: string, attributes: object): Promise<unknown> } | undefined
}

export interface ProfileContextSlice {
  dir?: string | undefined
}

/** `connection.admit`: the 401/403 a refused request must be answered with. */
export interface ConnectionAdmission {
  readonly rejection?: 401 | 403 | undefined
}

export interface ConnectionSlice {
  admit(request: unknown): ConnectionAdmission
}

/**
 * `ctx.webServer` — the carrier's route registry.
 *
 * The carrier calls a handler with Node's `IncomingMessage`/`ServerResponse`,
 * which this file may not name, so both positions are `never`: any handler shape
 * is accepted here, and `src/status-route.ts` is where the real pair is declared.
 */
export interface WebServerSlice {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: never, response: never) => unknown
  }): unknown
}

export interface AgentSessionSlice {
  sessionId?: string | undefined
  /** Older sessions carry `id` where current ones carry `sessionId`. */
  id?: string | undefined
  header?: { cwd?: unknown } | undefined
}

export interface AgentInboxSlice {
  prepend(target: 'next-step', message: unknown): unknown
}

export interface AgentSlice {
  id?: string | undefined
  session?: AgentSessionSlice | undefined
  inbox?: AgentInboxSlice | undefined
}

/** The slice of a pending tool call the gate reads. */
export interface ToolExecutionSlice {
  readonly agent?: AgentSlice | undefined
  readonly signal?: AbortSignal | undefined
}

/** `agent/pre-step`'s answer: reject the step, or enter it with these messages. */
export type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

export interface PreStepPayload {
  agent: AgentSlice
  messages: unknown[]
  turn: number
  step: number
  signal?: AbortSignal | undefined
}

/** The DSH events this plugin listens to, with the payload slice each handler reads. */
export interface PluginEvents {
  'agent/created'(payload: { agent: AgentSlice }): unknown
  'tools/pre-execute'(exec: ToolExecutionSlice, next: () => Promise<unknown>): Promise<unknown>
  'agent/pre-step'(
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision | undefined>,
  ): Promise<PreStepDecision | undefined>
}

/**
 * The cordis context as this plugin consumes it.
 *
 * `get` is typed per service for the three names actually read, and stays
 * `unknown` for anything else — the service object is a cordis traceable proxy,
 * so `src/runtime.ts` verifies the one it cares about by prototype identity and
 * behaviour rather than by trusting this declaration.
 */
export interface PluginContext {
  logger?: LoggerLike | undefined
  loader?: LoaderSlice | undefined
  webServer: WebServerSlice
  get(name: 'connection'): ConnectionSlice | undefined
  get(name: 'profileContext'): ProfileContextSlice | undefined
  get(name: string): unknown
  on<K extends keyof PluginEvents>(name: K, listener: PluginEvents[K]): unknown
  inject(deps: readonly string[], callback: (scope: PluginContext) => void): unknown
  effect(callback: () => unknown, name?: string): unknown
}

export type GateTools = 'all' | 'spawning' | 'none'
export type InjectSensitive = 'all' | 'filter'

/**
 * The resolved plugin configuration: `index.ts`'s schemastery schema with every
 * default applied, which is exactly what the runtime, the gate and the status
 * route read.
 *
 * Every field is required here even though the schema supplies it, because the
 * schema itself is optional (see `Config` in `src/index.ts`): a host that cannot
 * resolve `@deepseek-ai/schemastery` passes the raw user config straight
 * through, so readers keep their `?? []` guards.
 */
export interface Settings {
  enabled: boolean
  /** Empty string resolves `direnv` through `PATH`. */
  direnvPath: string
  /** The gate's waiting budget, not the evaluation child's deadline. */
  loadTimeoutMs: number
  /** The evaluation child's kill deadline; `0` = none. */
  evaluateTimeoutMs: number
  gateTools: GateTools
  injectSensitive: InjectSensitive
  notifyModel: boolean
  sidebar: boolean
  disabledDirs: string[]
}
