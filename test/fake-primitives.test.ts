/**
 * The stub guard: every official stand-in must refuse a prop its real component
 * does not take.
 *
 * `test/client-contract.test.ts` proves the panel hands over the right props;
 * that proof is worth nothing while a stand-in swallows a wrong name in silence,
 * because no assertion can then tell `tone` from `tones`. So each stub carries
 * the official prop list and throws naming both the component and the prop, and
 * this file pins both halves per component: the official props pass, one unknown
 * prop does not. The sets below mirror the shipped `.d.ts` — a list that drifts
 * wider than the official one is a guard that stopped guarding.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeReact } from './helpers/fake-react.ts'
import { createPrimitives } from './helpers/fake-primitives.ts'

/** One stub, called the way the fake React calls it. */
function part(namespace: Record<string, unknown>, name: string): (props: Record<string, unknown>) => unknown {
  const member = namespace[name]
  assert.equal(typeof member, 'function', `${name} is a stub component`)
  return member as (props: Record<string, unknown>) => unknown
}

/** Every prop one official component takes, as a set the stub must accept. */
const OFFICIAL_PROPS: Record<string, Record<string, unknown>> = {
  Tag: { tone: 'outline', className: 'c', children: 'label' },
  StateDot: { state: 'done', size: 10, appearance: 'dot', className: 'c' },
  PathLabel: { path: '/a/b', className: 'c', title: '/a/b', id: 'p', style: { flex: 1 } },
  Pill: { active: true, className: 'c', children: '3 entries', type: 'button', title: 't', disabled: false, onClick: () => undefined },
  Button: {
    variant: 'toolbar',
    size: 'sm',
    icon: null,
    className: 'c',
    children: 'reload',
    type: 'button',
    title: 't',
    disabled: false,
    onClick: () => undefined,
    'aria-label': 'l',
  },
  Tooltip: {
    label: 'Click to reveal the value',
    side: 'right',
    align: 'center',
    delayMs: 100,
    gap: 8,
    disabled: false,
    portal: true,
    maxWidth: 320,
    children: 'kid',
  },
  Input: {
    icon: null,
    className: 'c',
    type: 'search',
    value: 'q',
    placeholder: 'p',
    'aria-label': 'l',
    onChange: () => undefined,
    disabled: false,
    autoFocus: true,
  },
  DisclosureRow: {
    icon: null,
    title: 'API_TOKEN',
    open: false,
    expandable: true,
    onToggle: () => undefined,
    running: false,
    expandOnRowClick: true,
    previewChevron: false,
    keepContentWhenOpen: true,
    collapsedContent: null,
    children: 'body',
    className: 'c',
    rowClassName: 'r',
    leadingClassName: 'l',
    chevronClassName: 'ch',
    titleClassName: 'ti',
  },
  IconCopyOutlineRegular: { size: 14, className: 'c' },
}

test('every stub accepts its official props and refuses any other name', () => {
  const stubs = createPrimitives(createFakeReact().React.createElement)
  for (const [name, props] of Object.entries(OFFICIAL_PROPS)) {
    const component = part(stubs.namespace, name)
    assert.doesNotThrow(() => component({ ...props }), `${name} accepts its official props`)
    assert.throws(
      () => component({ ...props, nonsense: 1 }),
      (error: unknown) => error instanceof Error && error.message === `the official ${name} takes no prop "nonsense"`,
      `${name} refuses an unknown prop and names it`,
    )
  }
})

test('a component name the package does not export throws, prototype members included', () => {
  const stubs = createPrimitives(createFakeReact().React.createElement)
  assert.throws(
    () => stubs.namespace.Tagx,
    (error: unknown) => error instanceof Error && error.message.includes('Tagx'),
    'a typo in a component name is loud rather than an undefined element type',
  )
  assert.throws(
    () => stubs.namespace.toString,
    (error: unknown) => error instanceof Error && error.message.includes('toString'),
    'a prototype member is not an export either',
  )
})
