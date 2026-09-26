/**
 * The official DSH UI primitives, reached through the client module table.
 *
 * The panel is drawn out of the harness's own atoms so an installed theme
 * restyles it with the rest of the shell: no color, radius, border, shadow or
 * font is written here or in `styles.ts`.
 *
 * Two facts shape the load below. First, the module table is the only module
 * mechanism the browser half has, and it answers a fixed seed list —
 * `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
 * `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
 * `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
 * `@deepseek-ai/dsh-client-ui-dockkit`. A specifier outside that list makes the
 * table throw and takes the whole web app down with no URL, so the two
 * specifiers this bundle names are pinned by a scan of the artifact
 * (`test/client-contract.test.ts`) and by the harness's own module table.
 * Second, the package ships types this half cannot import — the browser build
 * runs with `types: []` and the package is not one of our dependencies — so
 * every member used here is declared locally: the interfaces below transcribe
 * the official prop names and types for the props this panel may hand over, and
 * `h` in `client/react.ts` checks every render site against them. A prop this
 * file omits, renames or mistypes turns a working call site into a build
 * failure, which is the point.
 */

import { asObject } from './ctx.ts'
import type { Component, ReactElement, RequireFn } from './react.ts'

const PRIMITIVES_ID = '@deepseek-ai/dsh-client-ui-primitives'

export type TagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'

export type DotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/** The unit of an official relative-time bucket; the words stay our dictionary's. */
export type RelativeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'

export interface RelativeTime {
  readonly unit: RelativeUnit
  readonly n: number
}

export interface IconProps {
  size?: number | undefined
  className?: string | undefined
}

export interface TagProps {
  tone?: TagTone | undefined
  className?: string | undefined
  children?: unknown
}

export interface StateDotProps {
  state: DotState
  size?: number | undefined
  appearance?: 'dot' | 'step' | undefined
  className?: string | undefined
}

export interface PathLabelProps {
  path: string
  className?: string | undefined
}

export interface PillProps {
  active?: boolean | undefined
  className?: string | undefined
  title?: string | undefined
  disabled?: boolean | undefined
  onClick?: (() => void) | undefined
  children?: unknown
}

export interface ButtonProps {
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar' | undefined
  size?: 'md' | 'sm' | undefined
  icon?: unknown
  className?: string | undefined
  title?: string | undefined
  'aria-label'?: string | undefined
  disabled?: boolean | undefined
  onClick?: (() => void) | undefined
  children?: unknown
}

export interface DisclosureRowProps {
  icon: unknown
  title: string
  open: boolean
  expandable: boolean
  onToggle: () => void
  expandOnRowClick?: boolean | undefined
  keepContentWhenOpen?: boolean | undefined
  collapsedContent?: unknown
  children?: unknown
}

export interface TooltipProps {
  label: string | (() => string)
  side?: 'right' | 'bottom' | 'top' | undefined
  align?: 'center' | 'end' | undefined
  delayMs?: number | undefined
  gap?: number | undefined
  disabled?: boolean | undefined
  portal?: boolean | undefined
  maxWidth?: number | undefined
  children: ReactElement
}

export interface InputProps {
  type?: string | undefined
  value?: string | undefined
  placeholder?: string | undefined
  icon?: unknown
  className?: string | undefined
  'aria-label'?: string | undefined
  onChange?: ((event: { target: { value: string } }) => void) | undefined
}

/** The members this plugin uses; the rest of the package stays unused. */
export interface Primitives {
  Button: Component<ButtonProps>
  DisclosureRow: Component<DisclosureRowProps>
  Input: Component<InputProps>
  PathLabel: Component<PathLabelProps>
  Pill: Component<PillProps>
  StateDot: Component<StateDotProps>
  Tag: Component<TagProps>
  Tooltip: Component<TooltipProps>
  IconCheckOutlineRegular: Component<IconProps>
  IconCloseOutlineRegular: Component<IconProps>
  IconCopyOutlineRegular: Component<IconProps>
  IconFlatListOutlineRegular: Component<IconProps>
  IconFolderOpenOutlineRegular: Component<IconProps>
  IconPlusOutlineRegular: Component<IconProps>
  IconRefreshOutlineRegular: Component<IconProps>
  IconSearchOutlineRegular: Component<IconProps>
  IconShieldOutlineRegular: Component<IconProps>
  IconSlidersTwoOutlineRegular: Component<IconProps>
  relativeTime(at: number, now: number): RelativeTime
  writeClipboard(text: string): Promise<boolean>
}

/** The host module table, reached once, for the primitives alone. */
const table: { require: RequireFn | null } = { require: null }

let loaded: Primitives | null = null

/**
 * The one probe every member passes: an element type or a callable, never a
 * hole. A renamed export is a loud boot failure rather than a panel that
 * silently drops the block it was meant to draw.
 */
function member(namespace: Record<string, unknown>, name: string): unknown {
  const value = namespace[name]
  if (typeof value === 'function' || (typeof value === 'object' && value !== null)) return value
  throw new Error(`the client module table answered no usable ${PRIMITIVES_ID}/${name}`)
}

function part<P>(namespace: Record<string, unknown>, name: string): Component<P> {
  return member(namespace, name) as Component<P>
}

/**
 * Render sites read the members by name as well, so the copy keeps the same
 * loud answer to a name that is not there: an absent element type renders
 * nothing at all, which is the one panel failure a reader cannot see.
 */
function guard(members: Primitives): Primitives {
  return new Proxy(members, {
    get(target, property, receiver) {
      if (typeof property !== 'symbol' && !Object.prototype.hasOwnProperty.call(target, property)) {
        throw new Error(`the official primitives carry no ${property}`)
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

export function installPrimitives(load: RequireFn): void {
  table.require = load
  const namespace = asObject(table.require('@deepseek-ai/dsh-client-ui-primitives'))
  if (namespace === null) throw new Error(`the client module table did not answer ${PRIMITIVES_ID}`)
  loaded = guard(
    Object.freeze({
      Button: part(namespace, 'Button'),
      DisclosureRow: part(namespace, 'DisclosureRow'),
      Input: part(namespace, 'Input'),
      PathLabel: part(namespace, 'PathLabel'),
      Pill: part(namespace, 'Pill'),
      StateDot: part(namespace, 'StateDot'),
      Tag: part(namespace, 'Tag'),
      Tooltip: part(namespace, 'Tooltip'),
      IconCheckOutlineRegular: part(namespace, 'IconCheckOutlineRegular'),
      IconCloseOutlineRegular: part(namespace, 'IconCloseOutlineRegular'),
      IconCopyOutlineRegular: part(namespace, 'IconCopyOutlineRegular'),
      IconFlatListOutlineRegular: part(namespace, 'IconFlatListOutlineRegular'),
      IconFolderOpenOutlineRegular: part(namespace, 'IconFolderOpenOutlineRegular'),
      IconPlusOutlineRegular: part(namespace, 'IconPlusOutlineRegular'),
      IconRefreshOutlineRegular: part(namespace, 'IconRefreshOutlineRegular'),
      IconSearchOutlineRegular: part(namespace, 'IconSearchOutlineRegular'),
      IconShieldOutlineRegular: part(namespace, 'IconShieldOutlineRegular'),
      IconSlidersTwoOutlineRegular: part(namespace, 'IconSlidersTwoOutlineRegular'),
      relativeTime: member(namespace, 'relativeTime') as Primitives['relativeTime'],
      writeClipboard: member(namespace, 'writeClipboard') as Primitives['writeClipboard'],
    }),
  )
}

export function ui(): Primitives {
  if (loaded === null) throw new Error('the official UI primitives are not installed yet')
  return loaded
}
