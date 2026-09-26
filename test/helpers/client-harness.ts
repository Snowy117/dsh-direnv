/**
 * A no-browser harness for the dsh-direnv client half.
 *
 * `client.js` is a browser module: it registers itself through
 * `window.__ModuleLoader__.load({ id, factory })`, its factory answers `require`
 * for `react` only, and everything it renders is `React.createElement`. So a
 * contract test needs exactly three fakes — the module loader, a React that
 * really mounts components and runs effects (see ./fake-react.ts), and the `ctx`
 * services the plugin reads — and the real file supplies everything else.
 *
 * What it does NOT model: the real SlotCore (registrations are recorded, and
 * `slots.inject` fires immediately), the real SnapshotStore, and a real DOM
 * (`document` stays undefined, so the client's style installer is a no-op).
 */

import { pathToFileURL } from 'node:url'

import { createFakeReact } from './fake-react.ts'
import type { FakeReact } from './fake-react.ts'
import { isCallable, isRecord } from './guards.ts'
import { CLIENT_FILE } from './package-manifest.ts'

let importCounter = 0

export interface ClientPlugin {
  apply(ctx: unknown): void
}

export interface ClientDefinition {
  id: string
  factory(require: (name: string) => unknown): ClientPlugin
}

function isClientDefinition(value: unknown): value is ClientDefinition {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.factory === 'function'
}

/**
 * Execute the real `client.js` with a stubbed module loader and return the
 * `{ id, factory }` definition it registers.
 *
 * Each call imports a fresh copy (cache-busted), so one test's captured factory
 * never leaks into the next.
 */
export async function loadClientDefinition(): Promise<ClientDefinition> {
  let definition: unknown = null
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const previousWindow: unknown = Reflect.get(globalThis, 'window')
  Reflect.set(globalThis, 'window', {
    __ModuleLoader__: {
      load(candidate: unknown): void {
        definition = candidate
      },
    },
  })
  try {
    importCounter += 1
    await import(`${pathToFileURL(CLIENT_FILE).href}?client-contract=${String(importCounter)}`)
  } finally {
    if (hadWindow) Reflect.set(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
  if (!isClientDefinition(definition)) {
    throw new Error('client.js did not register through window.__ModuleLoader__.load')
  }
  return definition
}

export interface ComposerBlock {
  reason?: string | undefined
}

export interface BlockStore {
  getSnapshot(): ComposerBlock | undefined
}

export interface BlockRegistry {
  writes: { sessionId: string; block: ComposerBlock | undefined }[]
  set(sessionId: string, block: ComposerBlock | undefined): void
  storeFor(sessionId: string): BlockStore
  forget(sessionId: string): void
  current(sessionId: string): ComposerBlock | undefined
}

interface MutableBlockStore extends BlockStore {
  value: ComposerBlock | undefined
}

/**
 * The per-session composer-block registry, mirroring the shipped
 * `ComposerBlockRegistry`: last writer wins, and `set` is a no-op when the
 * reason is unchanged.
 */
export function createBlockRegistry(): BlockRegistry {
  const stores = new Map<string, MutableBlockStore>()
  const writes: { sessionId: string; block: ComposerBlock | undefined }[] = []
  const storeFor = (sessionId: string): MutableBlockStore => {
    let store = stores.get(sessionId)
    if (store === undefined) {
      const created: MutableBlockStore = {
        value: undefined,
        getSnapshot: () => created.value,
      }
      store = created
      stores.set(sessionId, created)
    }
    return store
  }
  return {
    writes,
    set(sessionId, block) {
      writes.push({ sessionId, block })
      const store = storeFor(sessionId)
      if ((store.getSnapshot()?.reason ?? undefined) === (block?.reason ?? undefined)) return
      store.value = block
    },
    storeFor,
    forget(sessionId) {
      stores.delete(sessionId)
    },
    current(sessionId) {
      return storeFor(sessionId).getSnapshot()
    },
  }
}

export interface Reply {
  contentType?: string | undefined
  status?: number | undefined
  body?: unknown
}

/** 200 with a JSON content type. */
export function jsonReply(body: unknown): Reply {
  return { contentType: 'application/json; charset=utf-8', status: 200, body: JSON.stringify(body) }
}

/** 200 with a body that is not JSON, as the SPA fallback answers an unknown path. */
export function spaFallbackReply(): Reply {
  return { contentType: 'text/html; charset=utf-8', status: 200, body: '<!doctype html><html></html>' }
}

/** Any non-2xx answer. */
export function errorReply(status: number): Reply {
  return { contentType: 'application/json; charset=utf-8', status, body: JSON.stringify({ ok: false }) }
}

/** 200 claiming JSON with a body that does not parse. */
export function brokenJsonReply(): Reply {
  return { contentType: 'application/json', status: 200, body: '{not json at all' }
}

interface FakeResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  json(): Promise<unknown>
}

function toResponse(reply: Reply): FakeResponse {
  const status = typeof reply.status === 'number' ? reply.status : 200
  const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? (reply.contentType ?? 'application/json') : null
      },
    },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve().then((): unknown => JSON.parse(body)),
  }
}

export interface FetchCall {
  url: string
  init: unknown
  index: number
}

export type Responder = (call: FetchCall) => Reply

export interface Notification {
  level: string
  text: string
  actx?: unknown
  sessionId?: string
}

export interface Registration {
  spec: { name: string; inject(sessionId: string): Record<string, unknown> }
  Component: unknown
}

interface LocalStorageLike {
  readonly store: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * The globals this harness installs. No DOM lib is loaded in the test project and
 * `localStorage` is not a Node declaration either, so the harness owns the shape
 * of every global it replaces rather than borrowing a type the client bundle was
 * never compiled against.
 */
interface ObservedGlobals {
  fetch: (url: unknown, init?: unknown) => Promise<FakeResponse>
  setInterval: (fn: () => void) => number
  clearInterval: (id: number) => void
  localStorage: LocalStorageLike
}

const observed = globalThis as unknown as ObservedGlobals

export interface Harness {
  definition: ClientDefinition
  plugin: ClientPlugin
  ctx: unknown
  react: FakeReact
  blocks: BlockRegistry
  notifications: Notification[]
  registrations: Map<string, Registration>
  tabTypes: unknown[]
  panelRegistration: Registration
  dockRegistration: Registration | undefined
  titleRegistration: Registration | undefined
  debugLines: string[]
  errorLines: string[]
  fetchCalls: FetchCall[]
  sessionId: string
  urls(): string[]
  lastUrl(): string | null
  respond(next: Responder): void
  settle(turns?: number): Promise<void>
  tick(): void
  /** The hub instance the panel registration injects, for direct assertions. */
  hub(): unknown
  /** Mount the sidebar panel body exactly as the keyed seat would. */
  mountPanel(): number
  /** Mount the invisible composer dock entry, which owns the failure toast. */
  mountDock(): number
  unmount(handle: number): void
  dispose(): void
}

export interface HarnessOptions {
  /** Scripted HTTP answers. */
  responder?: Responder | undefined
  /** The session every surface is addressed by. */
  sessionId?: string | undefined
  /** Locale the client's message table should answer with. */
  locale?: string | undefined
}

/**
 * Boot the real client plugin against fakes, and mount the sidebar panel and the
 * composer dock the way the slot framework would.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const sessionId = options.sessionId ?? 'session-contract'
  const definition = await loadClientDefinition()
  const react = createFakeReact()
  const blocks = createBlockRegistry()
  const notifications: Notification[] = []
  const registrations = new Map<string, Registration>()
  const tabTypes: unknown[] = []
  const cleanups: unknown[] = []
  const fetchCalls: FetchCall[] = []
  const intervals = new Map<number, () => void>()
  const debugLines: string[] = []
  const errorLines: string[] = []

  let responder: Responder = options.responder ?? (() => jsonReply({ ok: true, status: null }))
  let intervalSeq = 0

  const services: Record<string, unknown> = {
    conversation: {
      blocks,
      input: {
        for(actx: unknown) {
          return {
            notify(level: string, text: string): boolean {
              notifications.push({ level, text, actx })
              return true
            },
          }
        },
        shell(id: string) {
          return {
            notify(level: string, text: string): boolean {
              notifications.push({ level, text, sessionId: id })
              return true
            },
          }
        },
      },
    },
    sessions: {
      scope(id: string) {
        return { sessionId: id }
      },
    },
  }

  if (options.locale !== undefined) {
    services.locale = {
      register() {
        return () => {}
      },
      getLocale() {
        return { active: options.locale }
      },
    }
  }

  const ctx = {
    get(name: string): unknown {
      return services[name]
    },
    slots: {
      inject(_name: string, setup: () => unknown): () => void {
        const dispose = setup()
        return isCallable(dispose) ? dispose : () => {}
      },
      register(spec: Registration['spec'], Component: unknown): () => void {
        registrations.set(spec.name, { spec, Component })
        return () => {
          registrations.delete(spec.name)
        }
      },
    },
    sidebarRightTabs: {
      register(tabType: unknown): () => void {
        tabTypes.push(tabType)
        return () => {}
      },
    },
    effect(setup: () => unknown): () => void {
      cleanups.push(setup())
      return () => {}
    },
  }

  const saved = {
    fetch: globalThis.fetch,
    hadFetch: Object.prototype.hasOwnProperty.call(globalThis, 'fetch'),
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    hadLocalStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage'),
    localStorage: Reflect.get(globalThis, 'localStorage') as unknown,
    consoleDebug: console.debug,
    consoleError: console.error,
  }

  observed.fetch = (url, init) => {
    const call: FetchCall = { url: String(url), init, index: fetchCalls.length }
    fetchCalls.push(call)
    return Promise.resolve().then(() => toResponse(responder(call)))
  }
  observed.setInterval = (fn) => {
    intervalSeq += 1
    intervals.set(intervalSeq, fn)
    return intervalSeq
  }
  observed.clearInterval = (id) => {
    intervals.delete(id)
  }
  observed.localStorage = {
    store: new Map<string, string>(),
    getItem(key) {
      return this.store.has(key) ? (this.store.get(key) ?? null) : null
    },
    setItem(key, value) {
      this.store.set(key, String(value))
    },
    removeItem(key) {
      this.store.delete(key)
    },
  }
  console.debug = (...args: unknown[]) => {
    debugLines.push(args.map(String).join(' '))
  }
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map(String).join(' '))
  }

  const plugin = definition.factory((name) => {
    if (name === 'react') return react.React
    throw new Error(`the client module table answers react only, not ${name}`)
  })
  plugin.apply(ctx)

  const panelRegistration = registrations.get('sidebar.right.pane.tab')
  const dockRegistration = registrations.get('conversation.input.dock')
  const titleRegistration = registrations.get('sidebar.right.pane.tab.title')
  if (panelRegistration === undefined) throw new Error('the client registered no sidebar.right.pane.tab body')

  async function settle(turns = 16): Promise<void> {
    for (let index = 0; index < turns; index += 1) {
      await Promise.resolve()
      react.flush()
    }
  }

  function tick(): void {
    for (const fn of [...intervals.values()]) fn()
    react.flush()
  }

  return {
    definition,
    plugin,
    ctx,
    react,
    blocks,
    notifications,
    registrations,
    tabTypes,
    panelRegistration,
    dockRegistration,
    titleRegistration,
    debugLines,
    errorLines,
    fetchCalls,
    sessionId,
    urls: () => fetchCalls.map((call) => call.url),
    lastUrl: () => (fetchCalls.length === 0 ? null : fetchCalls[fetchCalls.length - 1]!.url),
    respond(next) {
      responder = next
    },
    settle,
    tick,
    hub() {
      return panelRegistration.spec.inject(sessionId).hub
    },
    mountPanel() {
      const props = panelRegistration.spec.inject(sessionId)
      return react.render(react.React.createElement(panelRegistration.Component, props))
    },
    mountDock() {
      if (dockRegistration === undefined) throw new Error('the client registered no conversation.input.dock entry')
      const props = dockRegistration.spec.inject(sessionId)
      return react.render(react.React.createElement(dockRegistration.Component, props))
    },
    unmount(handle) {
      react.unmount(handle)
      react.flush()
    },
    dispose() {
      for (const cleanup of cleanups.slice().reverse()) {
        if (isCallable(cleanup)) cleanup()
      }
      cleanups.length = 0
      intervals.clear()
      if (saved.hadFetch) globalThis.fetch = saved.fetch
      else Reflect.deleteProperty(globalThis, 'fetch')
      globalThis.setInterval = saved.setInterval
      globalThis.clearInterval = saved.clearInterval
      if (saved.hadLocalStorage) Reflect.set(globalThis, 'localStorage', saved.localStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
      console.debug = saved.consoleDebug
      console.error = saved.consoleError
    },
  }
}
