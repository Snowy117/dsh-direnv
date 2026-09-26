/**
 * The status envelope `src/status-route.ts` answers, as a fixture.
 *
 * Two test files mount the real panel against it — the client/host contract test
 * and the panel-surface test — so the shape lives here once rather than drifting
 * between copies. It is the route's own shape: the record is nested under
 * `status`, and `ok` / `plugin` / `sessionId` / `dir` / `gate` / `config` sit
 * beside it. A reader that takes the envelope for the record finds nothing,
 * which is the bug the contract test exists to catch.
 */

export const SESSION = 'session-contract'
export const DIR = '/work/ws-contract'

/** The one host timestamp every envelope carries, so the clock assertion is not a moving target. */
export const AT = 1_737_000_000_000

/** One `PATH` diff entry exactly as the host serializes it. */
export interface EnvelopePathEntry {
  value: string
  change: string
}

export interface EnvelopeVariable {
  name: string
  sensitive: boolean
  hasValue: boolean
}

export interface EnvelopeStatus {
  dir: string
  state: string
  at: number
  ms: number
  envrcPath: string
  memoHit: boolean
  watchCount: number
  variables: EnvelopeVariable[]
  pathEntries: EnvelopePathEntry[]
  credentials: string[]
  errorSummary: string | null
  warnings: string[]
  env: Record<string, string> | null
}

export interface Envelope {
  ok: boolean
  plugin: { name: string; version: string }
  sessionId: string
  dir: string
  status: EnvelopeStatus
  gate: { dir: string; state: string; result: string; elapsedMs: number }
  config: { disabledDirs: string[]; loadTimeoutMs: number }
}

export interface EnvelopeOptions {
  state?: string
  env?: Record<string, string> | null
  overrides?: Partial<EnvelopeStatus>
}

export const VARIABLES: EnvelopeVariable[] = [
  { name: 'API_TOKEN', sensitive: true, hasValue: true },
  { name: 'EDITOR', sensitive: false, hasValue: true },
  { name: 'PATH', sensitive: false, hasValue: true },
]

export const VALUES: Record<string, string> = {
  API_TOKEN: 'tok-live-123',
  EDITOR: 'vim',
  PATH: '/work/ws-contract/bin:/usr/bin',
}

/**
 * A realistic ordered diff: the base was
 * `/usr/bin:/opt/legacy/bin:/work/ws-contract/bin`, the new PATH prepends the
 * nix profile and drops `/opt/legacy/bin`.
 */
export const PATH_ENTRIES: EnvelopePathEntry[] = [
  { value: '/nix/store/abcd1234-nix-direnv/bin', change: 'added' },
  { value: '/opt/legacy/bin', change: 'removed' },
  { value: '/work/ws-contract/bin', change: 'unchanged' },
  { value: '/usr/bin', change: 'unchanged' },
]

export function envelope({ state = 'ok', env = null, overrides = {} }: EnvelopeOptions = {}): Envelope {
  return {
    ok: true,
    plugin: { name: 'dsh-direnv', version: '0.1.0' },
    sessionId: SESSION,
    dir: DIR,
    status: {
      dir: DIR,
      state,
      at: AT,
      ms: 1234,
      envrcPath: `${DIR}/.envrc`,
      memoHit: true,
      watchCount: 2,
      variables: VARIABLES.map((variable) => ({ ...variable })),
      pathEntries: PATH_ENTRIES.map((entry) => ({ ...entry })),
      credentials: ['API_TOKEN'],
      errorSummary: null,
      warnings: [],
      env,
      ...overrides,
    },
    gate: { dir: DIR, state: 'released', result: 'ok', elapsedMs: 12 },
    config: { disabledDirs: [], loadTimeoutMs: 300_000 },
  }
}

/** The host's other 200: a session with no directory it can resolve. */
export function noWorkspaceEnvelope(): {
  ok: boolean
  plugin: { name: string; version: string }
  sessionId: string
  dir: null
  status: null
  gate: null
} {
  return { ok: true, plugin: { name: 'dsh-direnv', version: '0.1.0' }, sessionId: SESSION, dir: null, status: null, gate: null }
}

/** A record with the envelope stripped off, which the reader must still accept. */
export function flatRecord(options?: EnvelopeOptions): EnvelopeStatus {
  return envelope(options).status
}
