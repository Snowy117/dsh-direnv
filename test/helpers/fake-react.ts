/**
 * The smallest React that can still catch a render/effect contract bug.
 *
 * `client.js` is a browser module: everything it renders is
 * `React.createElement`, so a contract test needs a React that really mounts
 * components and runs effects. This one keeps hook state per instance across
 * re-renders (reconciling children by key, then by position), runs effect
 * cleanups and dependency comparison, and exposes the rendered host tree for
 * text/DOM-ish assertions. Without that, a bug that only shows up after a poll
 * re-render would pass unnoticed.
 *
 * What it does NOT model: the real DOM (`document` stays undefined, so the
 * client's style installer is a no-op).
 */

import { isCallable } from './guards.ts'

const ELEMENT = Symbol('dsh-test.element')
const FRAGMENT = Symbol('dsh-test.fragment')

export interface FakeElement {
  $$typeof: typeof ELEMENT
  type: unknown
  key: string | null
  props: Record<string, unknown>
}

/** Anything `createElement` may be handed as a child, once flattened. */
export type Child = FakeElement | string | number

function isTextChild(value: Child): value is string | number {
  return typeof value === 'string' || typeof value === 'number'
}

function isElement(value: unknown): value is FakeElement {
  return typeof value === 'object' && value !== null && Reflect.get(value, '$$typeof') === ELEMENT
}

function isChild(value: unknown): value is Child {
  return typeof value === 'string' || typeof value === 'number' || isElement(value)
}

/**
 * One hook slot. `useState` fills `value`, `useEffect` fills `effect` / `deps` /
 * `pending` / `cleanup`: a slot's kind is decided by hook order, exactly as
 * React's own index-addressed table works, so one shape covers both.
 */
interface Hook {
  value?: unknown
  effect?: () => unknown
  deps?: readonly unknown[] | null
  pending?: boolean
  cleanup?: unknown
}

interface BaseInstance {
  parent: Instance | null
  slot: number
  children: Instance[]
  hooks: (Hook | undefined)[]
  key: string | null
}

export interface TextInstance extends BaseInstance {
  kind: 'text'
  text: string
}

export interface ElementInstance extends BaseInstance {
  kind: 'component' | 'fragment' | 'host'
  type: unknown
  props: Record<string, unknown>
  hookIndex: number
}

export type Instance = TextInstance | ElementInstance

export interface FakeReact {
  React: {
    createElement(type: unknown, config?: unknown, ...children: unknown[]): FakeElement
    Fragment: symbol
    useState(initial: unknown): [unknown, (next: unknown) => void]
    useEffect(effect: () => unknown, deps?: readonly unknown[]): void
  }
  render(element: FakeElement): number
  unmount(handle: number): void
  flush(): void
  textOf(handle: number): string
  findAll(handle: number, predicate: (instance: Instance) => boolean): Instance[]
  findByClass(handle: number, className: string): Instance | null
  click(node: Instance): void
}

/**
 * The fake React namespace plus tree helpers, mounted against its own root table.
 */
export function createFakeReact(): FakeReact {
  const state: { current: ElementInstance | null; dirty: Set<Instance>; roots: { instance: Instance }[] } = {
    current: null,
    dirty: new Set(),
    roots: [],
  }

  function createElement(type: unknown, config?: unknown, ...children: unknown[]): FakeElement {
    const props: Record<string, unknown> = {}
    let key: string | null = null
    if (typeof config === 'object' && config !== null) {
      for (const name of Object.keys(config)) {
        const value = Reflect.get(config, name)
        if (name === 'key') {
          key = value === null || value === undefined ? null : String(value)
          continue
        }
        if (name === 'ref' || name === '__self' || name === '__source') continue
        props[name] = value
      }
    }
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { $$typeof: ELEMENT, type, key, props }
  }

  function hookSlot(instance: ElementInstance, index: number): Hook | undefined {
    if (instance.hooks.length <= index) instance.hooks[index] = undefined
    return instance.hooks[index]
  }

  function useState(initial: unknown): [unknown, (next: unknown) => void] {
    const instance = state.current
    if (instance === null) throw new Error('useState called outside a component render')
    const index = instance.hookIndex
    instance.hookIndex += 1
    const existing = hookSlot(instance, index)
    const hook: Hook = existing ?? { value: isCallable(initial) ? initial() : initial }
    instance.hooks[index] = hook
    const setValue = (next: unknown): void => {
      const value = isCallable(next) ? next(hook.value) : next
      if (Object.is(value, hook.value)) return
      hook.value = value
      state.dirty.add(instance)
    }
    return [hook.value, setValue]
  }

  function useEffect(effect: () => unknown, deps?: readonly unknown[]): void {
    const instance = state.current
    if (instance === null) throw new Error('useEffect called outside a component render')
    const index = instance.hookIndex
    instance.hookIndex += 1
    const previous = hookSlot(instance, index)
    const nextDeps = deps === undefined ? null : Array.from(deps)
    const changed = previous === undefined || !sameDeps(previous.deps, nextDeps)
    instance.hooks[index] = {
      effect,
      deps: nextDeps,
      pending: changed,
      cleanup: previous === undefined ? undefined : previous.cleanup,
    }
  }

  function sameDeps(previous: readonly unknown[] | null | undefined, next: readonly unknown[] | null): boolean {
    if (previous === null || next === null || previous === undefined || next === undefined) return false
    if (previous.length !== next.length) return false
    for (let index = 0; index < previous.length; index += 1) {
      if (!Object.is(previous[index], next[index])) return false
    }
    return true
  }

  /** The tree node kind of an element child; text is decided before this is reached. */
  function elementKind(element: FakeElement): 'component' | 'fragment' | 'host' {
    if (typeof element.type === 'function') return 'component'
    if (element.type === FRAGMENT) return 'fragment'
    return 'host'
  }

  function createInstance(element: Child, parent: Instance | null, slot: number): Instance {
    if (isTextChild(element)) {
      return { kind: 'text', text: String(element), parent, slot, children: [], hooks: [], key: null }
    }
    return {
      kind: elementKind(element),
      type: element.type,
      props: element.props,
      key: element.key,
      parent,
      slot,
      children: [],
      hooks: [],
      hookIndex: 0,
    }
  }

  function compatible(instance: Instance, element: Child): boolean {
    if (isTextChild(element)) return instance.kind === 'text'
    if (instance.kind === 'text') return false
    if (instance.kind !== elementKind(element)) return false
    return instance.type === element.type && instance.key === element.key
  }

  function unmountInstance(instance: Instance): void {
    if (instance.kind === 'component') {
      for (const hook of instance.hooks) {
        if (hook !== undefined && isCallable(hook.cleanup)) hook.cleanup()
      }
    }
    for (const child of instance.children) unmountInstance(child)
  }

  function flattenChildren(value: unknown, out: Child[]): Child[] {
    if (value === null || value === undefined || value === false || value === true || value === '') return out
    if (Array.isArray(value)) {
      for (const item of value) flattenChildren(item, out)
      return out
    }
    if (isChild(value)) out.push(value)
    return out
  }

  function childrenOf(props: Record<string, unknown> | null | undefined): unknown {
    return props === null || props === undefined ? [] : props.children
  }

  function reconcileChildren(instance: ElementInstance, rawChildren: unknown): void {
    const elements = flattenChildren(rawChildren, [])
    const old = instance.children
    const byKey = new Map<string, Instance>()
    for (const child of old) if (child.key !== null) byKey.set(child.key, child)
    const used = new Set<Instance>()
    const next: Instance[] = []
    elements.forEach((element, slot) => {
      const key = isTextChild(element) ? null : element.key
      let candidate: Instance | undefined
      if (key !== null) {
        const keyed = byKey.get(key)
        if (keyed !== undefined && !used.has(keyed) && compatible(keyed, element)) candidate = keyed
      }
      const positional = old[slot]
      if (candidate === undefined && positional !== undefined && !used.has(positional) && compatible(positional, element)) {
        candidate = positional
      }
      if (candidate === undefined) {
        candidate = createInstance(element, instance, slot)
      } else if (candidate.kind === 'text') {
        // A reused node still receives the newly rendered content, exactly as a
        // DOM text node would.
        if (isTextChild(element)) candidate.text = typeof element === 'number' ? String(element) : element
      } else if (!isTextChild(element)) {
        candidate.props = element.props
      }
      candidate.slot = slot
      used.add(candidate)
      next.push(candidate)
    })
    for (const child of old) if (!used.has(child)) unmountInstance(child)
    instance.children = next
  }

  function renderInstance(instance: Instance): void {
    if (instance.kind === 'component') {
      instance.hookIndex = 0
      const previous = state.current
      state.current = instance
      let output: unknown
      try {
        const type = instance.type
        if (!isCallable(type)) throw new Error('a component instance lost its component type')
        output = type(instance.props)
      } finally {
        state.current = previous
      }
      reconcileChildren(instance, output)
      return
    }
    if (instance.kind === 'fragment') {
      reconcileChildren(instance, childrenOf(instance.props))
      return
    }
    if (instance.kind === 'host') reconcileChildren(instance, childrenOf(instance.props))
  }

  function renderTree(instance: Instance): void {
    renderInstance(instance)
    for (const child of instance.children) renderTree(child)
  }

  function containsDirty(instance: Instance): boolean {
    if (state.dirty.has(instance)) return true
    for (const child of instance.children) if (containsDirty(child)) return true
    return false
  }

  function runEffects(): void {
    const visit = (instance: Instance): void => {
      if (instance.kind === 'component') {
        for (const hook of instance.hooks) {
          if (hook === undefined || hook.pending !== true) continue
          hook.pending = false
          if (isCallable(hook.cleanup)) hook.cleanup()
          hook.cleanup = hook.effect?.()
        }
      }
      for (const child of instance.children) visit(child)
    }
    for (const root of state.roots) visit(root.instance)
  }

  function flush(): void {
    let guard = 0
    while (state.dirty.size > 0) {
      guard += 1
      if (guard > 100) {
        state.dirty.clear()
        throw new Error('the fake React render loop did not settle')
      }
      const targets = state.roots.filter((root) => containsDirty(root.instance))
      state.dirty.clear()
      for (const target of targets) renderTree(target.instance)
      runEffects()
    }
  }

  /**
   * Mount one element as a new root; the returned handle is what `unmount` takes.
   */
  function render(element: FakeElement): number {
    const instance = createInstance(element, null, 0)
    state.roots.push({ instance })
    const handle = state.roots.length - 1
    renderTree(instance)
    runEffects()
    flush()
    return handle
  }

  function unmount(handle: number): void {
    const root = state.roots[handle]
    if (root === undefined) return
    unmountInstance(root.instance)
    state.roots[handle] = { instance: createInstance('', null, 0) }
  }

  function walk(instance: Instance, visit: (instance: Instance) => void): void {
    visit(instance)
    for (const child of instance.children) walk(child, visit)
  }

  function textOf(handle: number): string {
    const root = state.roots[handle]
    if (root === undefined) return ''
    let text = ''
    walk(root.instance, (instance) => {
      if (instance.kind === 'text') text += instance.text
    })
    return text
  }

  function findAll(handle: number, predicate: (instance: Instance) => boolean): Instance[] {
    const root = state.roots[handle]
    if (root === undefined) return []
    const found: Instance[] = []
    walk(root.instance, (instance) => {
      if (predicate(instance)) found.push(instance)
    })
    return found
  }

  function findByClass(handle: number, className: string): Instance | null {
    return (
      findAll(
        handle,
        (instance) =>
          instance.kind === 'host' &&
          typeof instance.props.className === 'string' &&
          instance.props.className.includes(className),
      )[0] ?? null
    )
  }

  function click(node: Instance): void {
    if (node.kind === 'text') throw new Error('node has no onClick handler')
    const handler = node.props.onClick
    if (!isCallable(handler)) throw new Error('node has no onClick handler')
    handler({ preventDefault() {}, stopPropagation() {}, target: node, currentTarget: node })
    flush()
  }

  return {
    React: { createElement, Fragment: FRAGMENT, useState, useEffect },
    render,
    unmount,
    flush,
    textOf,
    findAll,
    findByClass,
    click,
  }
}
