/**
 * Honest stand-ins for the official UI primitives.
 *
 * The contract tests have to say which official component received which props,
 * so every stub renders a host element marked with `data-primitive` and keeps
 * the props the panel is expected to hand over. Each stub also carries the prop
 * names its official component really takes and throws on anything else: a
 * misspelled prop would otherwise be dropped in silence, leaving a panel that
 * passes every assertion here and renders nothing in the browser. The lists are
 * the official prop set (the component's own props plus the DOM attributes its
 * type forwards), never "whatever the client passes today".
 *
 * The map below is the whole namespace: a member the client asks for that is not
 * in it is a typo in a component name, and the proxy throws exactly where the
 * platform's module table throws for a specifier outside its seed list.
 *
 * The stubs mirror the two behaviours a caller may depend on — a disclosure row
 * renders its body only while `open`, and `relativeTime` buckets by the shipped
 * boundaries — so nothing here passes by answering everything the same way.
 */

import type { FakeElement } from './fake-react.ts'

type CreateElement = (type: unknown, config?: unknown, ...children: unknown[]) => FakeElement

interface AnonymousProps {
  [name: string]: unknown
}

export interface PrimitiveStubs {
  /** What the module table answers for the primitives specifier. */
  namespace: Record<string, unknown>
  /** The official name of a stubbed component, or `null` for anything else. */
  nameOf(type: unknown): string | null
  /** Every text the panel handed to the official clipboard writer, in order. */
  clipboard: string[]
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Shared by every product icon (`icons/props.d.ts`). */
const ICON_PROPS: readonly string[] = ['size', 'className']

const TAG_PROPS: readonly string[] = ['tone', 'className', 'children']
const STATE_DOT_PROPS: readonly string[] = ['state', 'size', 'appearance', 'className']
const PATH_LABEL_PROPS: readonly string[] = ['path', 'className', 'title', 'id', 'style']
const PILL_PROPS: readonly string[] = ['active', 'className', 'children', 'type', 'title', 'disabled', 'onClick']
const BUTTON_PROPS: readonly string[] = [
  'variant',
  'size',
  'icon',
  'className',
  'children',
  'type',
  'title',
  'disabled',
  'onClick',
  'aria-label',
]
const TOOLTIP_PROPS: readonly string[] = [
  'label',
  'side',
  'align',
  'delayMs',
  'gap',
  'disabled',
  'portal',
  'maxWidth',
  'children',
]
const INPUT_PROPS: readonly string[] = [
  'icon',
  'className',
  'type',
  'value',
  'placeholder',
  'aria-label',
  'onChange',
  'disabled',
  'autoFocus',
]
const DISCLOSURE_ROW_PROPS: readonly string[] = [
  'icon',
  'title',
  'open',
  'expandable',
  'onToggle',
  'running',
  'expandOnRowClick',
  'previewChevron',
  'keepContentWhenOpen',
  'collapsedContent',
  'children',
  'className',
  'rowClassName',
  'leadingClassName',
  'chevronClassName',
  'titleClassName',
]

/**
 * The shipped bucketing, mirrored so a test can pin the panel's wording to a
 * known age instead of to whatever `Date.now()` happens to be.
 */
function relativeTime(at: number, now: number): { unit: string; n: number } {
  const diff = Math.max(0, now - at)
  if (diff < MINUTE) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MINUTE) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}

export function createPrimitives(create: CreateElement): PrimitiveStubs {
  const clipboard: string[] = []
  const names = new Map<unknown, string>()

  function stub(
    name: string,
    allowed: readonly string[],
    render: (props: AnonymousProps) => FakeElement,
  ): (props: AnonymousProps) => unknown {
    const component = (props: AnonymousProps): unknown => {
      for (const prop of Object.keys(props)) {
        if (!allowed.includes(prop)) throw new Error(`the official ${name} takes no prop "${prop}"`)
      }
      return render(props)
    }
    names.set(component, name)
    return component
  }

  function icon(name: string): (props: AnonymousProps) => unknown {
    return stub(name, ICON_PROPS, (props) => create('span', { 'data-primitive': name, 'data-size': props.size }))
  }

  const Tag = stub('Tag', TAG_PROPS, (props) =>
    create('span', { 'data-primitive': 'Tag', 'data-tone': props.tone ?? 'outline' }, props.children),
  )

  const StateDot = stub('StateDot', STATE_DOT_PROPS, (props) =>
    create('span', { 'data-primitive': 'StateDot', 'data-state': props.state, 'aria-hidden': 'true' }),
  )

  const PathLabel = stub('PathLabel', PATH_LABEL_PROPS, (props) =>
    create('span', { 'data-primitive': 'PathLabel', 'data-path': props.path, title: props.path }, String(props.path)),
  )

  const Pill = stub('Pill', PILL_PROPS, (props) =>
    props.onClick === undefined
      ? create('span', { 'data-primitive': 'Pill', 'data-active': props.active === true }, props.children)
      : create(
          'button',
          {
            'data-primitive': 'Pill',
            'data-active': props.active === true,
            type: 'button',
            disabled: props.disabled === true,
            title: props.title,
            onClick: props.disabled === true ? undefined : props.onClick,
          },
          props.children,
        ),
  )

  const Button = stub('Button', BUTTON_PROPS, (props) =>
    create(
      'button',
      {
        'data-primitive': 'Button',
        'data-variant': props.variant ?? 'ghost',
        'data-size': props.size ?? 'md',
        type: 'button',
        disabled: props.disabled === true,
        title: props.title,
        onClick: props.disabled === true ? undefined : props.onClick,
      },
      props.icon ?? null,
      props.children,
    ),
  )

  const Tooltip = stub('Tooltip', TOOLTIP_PROPS, (props) =>
    create(
      'span',
      {
        'data-primitive': 'Tooltip',
        'data-label': props.label,
        'data-portal': props.portal === true,
        'data-disabled': props.disabled === true,
      },
      props.children,
    ),
  )

  const Input = stub('Input', INPUT_PROPS, (props) =>
    create(
      'span',
      { 'data-primitive': 'Input' },
      create('input', {
        type: props.type ?? 'text',
        value: props.value,
        placeholder: props.placeholder,
        'aria-label': props['aria-label'],
        onChange: props.onChange,
      }),
    ),
  )

  const DisclosureRow = stub('DisclosureRow', DISCLOSURE_ROW_PROPS, (props) => {
    const body = props.open === true ? create('div', { 'data-slot': 'body' }, props.children) : null
    const row = create(
      'div',
      {
        'data-primitive': 'DisclosureRow',
        'data-title': props.title,
        'data-open': props.open === true,
        role: props.expandOnRowClick === true ? 'button' : undefined,
        onClick: props.expandOnRowClick === true ? props.onToggle : undefined,
      },
      create('span', { 'data-slot': 'icon' }, props.icon ?? null),
      create('span', { 'data-slot': 'title' }, String(props.title)),
      props.collapsedContent ?? null,
    )
    return create('div', { 'data-primitive': 'DisclosureRow-root' }, row, body)
  })

  const table: Record<string, unknown> = {
    Button: Button,
    DisclosureRow: DisclosureRow,
    Input: Input,
    PathLabel: PathLabel,
    Pill: Pill,
    StateDot: StateDot,
    Tag: Tag,
    Tooltip: Tooltip,
    IconCheckOutlineRegular: icon('IconCheckOutlineRegular'),
    IconCloseOutlineRegular: icon('IconCloseOutlineRegular'),
    IconCopyOutlineRegular: icon('IconCopyOutlineRegular'),
    IconFlatListOutlineRegular: icon('IconFlatListOutlineRegular'),
    IconFolderOpenOutlineRegular: icon('IconFolderOpenOutlineRegular'),
    IconPlusOutlineRegular: icon('IconPlusOutlineRegular'),
    IconRefreshOutlineRegular: icon('IconRefreshOutlineRegular'),
    IconSearchOutlineRegular: icon('IconSearchOutlineRegular'),
    IconShieldOutlineRegular: icon('IconShieldOutlineRegular'),
    IconSlidersTwoOutlineRegular: icon('IconSlidersTwoOutlineRegular'),
    relativeTime: relativeTime,
    writeClipboard: (text: unknown): Promise<boolean> => {
      clipboard.push(String(text))
      return Promise.resolve(true)
    },
  }

  const namespace = new Proxy(table, {
    get(target, property, receiver) {
      if (typeof property === 'symbol' || Object.prototype.hasOwnProperty.call(target, property)) {
        return Reflect.get(target, property, receiver)
      }
      throw new Error(`the official primitives carry no ${String(property)}`)
    },
  })

  return {
    namespace: namespace,
    nameOf: (type) => names.get(type) ?? null,
    clipboard: clipboard,
  }
}
