/**
 * The defensive boundary to everything outside this module: the cordis context,
 * its services, and the browser globals. Nothing here throws, and nothing here
 * assumes a shape it has not just probed — a composition missing a service must
 * degrade to a quietly degraded panel, never to a failed render.
 */

/**
 * The context `apply()` is handed. Declared structurally because the real one is
 * a cordis traceable proxy: `get` is the service route this code prefers, the
 * index signature keeps the property fallback (`ctx[name]`) available, and every
 * member is still probed with `typeof` before it is called.
 */
export interface ClientContext {
  readonly [name: string]: unknown
  get(name: string): unknown
  slots: SlotsFace
  sidebarRightTabs: SidebarRightTabsFace
  effect(callback: () => unknown): unknown
}

export interface SlotSpec<P> {
  name: string
  key?: string | undefined
  id?: string | undefined
  order?: number | undefined
  inject: (sessionId: string) => P
}

export type Dispose = () => void

export interface SlotsFace {
  inject(name: string, setup: () => unknown): Dispose
  register<P>(spec: SlotSpec<P>, component: (props: P) => unknown): Dispose
}

export interface TabGuideEntry {
  id: string
  order: number
  title: () => string
  description: () => string
  icon: unknown
}

export interface TabType {
  id: string
  kind: string
  priority: string
  title: () => string
  guide: readonly TabGuideEntry[]
}

export interface SidebarRightTabsFace {
  register(tabType: TabType): Dispose
}

/** A JSON-shaped object view of an untyped value. */
export function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** `Array.isArray` without the `any[]` it narrows to. */
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

/** One service, by the route the context prefers, then by property access. */
export function safeService(ctx: ClientContext, name: string): unknown {
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(name)
      if (service !== undefined && service !== null) return service
    }
  } catch {
    /* fall through to property access */
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

export function report(error: unknown): void {
  try {
    if (typeof console !== 'undefined' && console !== null && typeof console.error === 'function') {
      console.error('[dsh-direnv]', error)
    }
  } catch {
    /* console is not critical */
  }
}

export function debugLog(...parts: unknown[]): void {
  try {
    if (typeof console !== 'undefined' && console !== null && typeof console.debug === 'function') {
      console.debug('[dsh-direnv]', ...parts)
    }
  } catch {
    /* console is not critical */
  }
}
