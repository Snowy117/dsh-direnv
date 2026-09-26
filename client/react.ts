/**
 * The react handle.
 *
 * The browser half is served as one plain script, so the module table's
 * `require` — the factory argument — is the only module mechanism there is. It
 * answers a fixed seed list, and this module spends one of the two specifiers
 * the bundle may name on `react` (`client/primitives.ts` spends the other). The
 * load below goes through a named member at install time, so a bundler neither
 * resolves it statically nor inlines react, and the call still reaches the
 * host's module table at runtime.
 *
 * `h` is also the whole compile-time defence for the panel's props: this half
 * carries no react types (`tsconfig.client.json` sets `types: []`) and cannot
 * import the primitives package's `.d.ts`, so the element and fragment types are
 * branded here and every official component call names its props after the
 * structural declarations in `client/primitives.ts`.
 */

export type RequireFn = (id: string) => unknown

declare const elementBrand: unique symbol

/**
 * What `h` answers, and what react accepts as a child. The brand is load-bearing:
 * without it a bare string would satisfy `TooltipProps.children`, which the
 * official component clones into its anchor.
 */
export interface ReactElement {
  readonly [elementBrand]: true
}

declare const fragmentBrand: unique symbol

/** The host's `Fragment`, handed back to `h` as an element type. */
export interface Fragment {
  readonly [fragmentBrand]: true
}

/**
 * An element type a render site may call: our own components and the official
 * primitives. This half never calls one itself, and the shipped `DisclosureRow`
 * is a `memo` object rather than a function, so the callable shape exists only
 * for the props check at the call site.
 */
export type Component<P> = (props: P) => unknown

/** Props react consumes itself and never forwards to the component. */
export interface ElementProps {
  key?: string | number | null | undefined
}

/** A host element's props: the platform's own vocabulary, deliberately declared nowhere here. */
export interface HostProps {
  readonly [name: string]: unknown
}

/**
 * The slice of react this plugin uses. Structural on purpose: the browser build
 * carries no react types, and the host's react is whatever the host ships.
 */
export interface ReactApi {
  createElement(type: unknown, config?: unknown, ...children: unknown[]): ReactElement
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

/**
 * `React.createElement`: the classic runtime, since JSX would need an import.
 *
 * The overloads carry the props check, and `NoInfer` is what makes it real: with
 * a bare `P` the compiler would infer `P` from the object literal, so a
 * misspelled `tones` would widen `TagProps` instead of erroring. Pinned to the
 * element type, the literal is checked against the declared props — an unknown
 * name, a missing required prop and a wrong value type all fail the build. Host
 * elements (`'div'`, `'svg'`, …) stay loose on purpose, and only the host's
 * opaque `Fragment` is a third shape.
 */
export function h<P>(type: Component<P>, config: NoInfer<P> & ElementProps, ...children: unknown[]): ReactElement
export function h(type: string, config: HostProps | null | undefined, ...children: unknown[]): ReactElement
export function h(type: Fragment, config: ElementProps | null | undefined, ...children: unknown[]): ReactElement
export function h(type: unknown, config?: unknown, ...children: unknown[]): ReactElement {
  return required().createElement(type, config, ...children)
}

export function fragment(): Fragment {
  return required().Fragment as Fragment
}

export function useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void] {
  return required().useState(initial)
}

export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
  required().useEffect(effect, deps)
}
