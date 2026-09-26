/**
 * The react handle.
 *
 * The browser half is served as one plain script, so the module table's
 * `require` — the factory argument — is the only module mechanism there is, and
 * it answers `react` alone. The load below is deliberately the bundle's single
 * `require(`: it goes through a named member at install time, so a bundler
 * neither resolves it statically nor inlines react, and the call still reaches
 * the host's module table at runtime.
 */

export type RequireFn = (id: string) => unknown

/**
 * The slice of react this plugin uses. Structural on purpose: the browser build
 * carries no react types, and the host's react is whatever the host ships.
 */
export interface ReactApi {
  createElement(type: unknown, config?: unknown, ...children: unknown[]): unknown
  Fragment: unknown
  useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

/** The host module table, reached exactly once, for `react` alone. */
const hostModules: { require: RequireFn | null } = { require: null }

let api: ReactApi | null = null

/** One assertion, justified by the three probes: the members are checked here. */
function asReactApi(value: unknown): ReactApi | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<ReactApi>
  if (typeof candidate.createElement !== 'function') return null
  if (typeof candidate.useState !== 'function') return null
  if (typeof candidate.useEffect !== 'function') return null
  return candidate as ReactApi
}

function required(): ReactApi {
  if (api === null) throw new Error('react is not installed: the client module table did not answer it')
  return api
}

export function installReact(requireFromHost: RequireFn): void {
  hostModules.require = requireFromHost
  const react = hostModules.require('react')
  api = asReactApi(react)
  if (api === null) throw new Error('the client module table did not answer a usable react')
}

/** `React.createElement`: the classic runtime, since JSX would need an import. */
export function h(type: unknown, config?: unknown, ...children: unknown[]): unknown {
  return required().createElement(type, config, ...children)
}

export function fragment(): unknown {
  return required().Fragment
}

export function useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void] {
  return required().useState(initial)
}

export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
  required().useEffect(effect, deps)
}
