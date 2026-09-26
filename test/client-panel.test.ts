/**
 * The panel surface: section hierarchy, copying a value, the code voice of a
 * disclosed value, and the fact that no environment byte can become markup.
 *
 * `test/client-contract.test.ts` owns the wire contract; this file owns what the
 * reader sees once the record arrived, and it mounts the real component tree
 * through the same harness (`test/helpers/client-harness.ts`).
 */
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { createHarness, jsonReply } from './helpers/client-harness.ts'
import type { Harness, HarnessOptions } from './helpers/client-harness.ts'
import type { ElementInstance } from './helpers/fake-react.ts'
import { CLIENT_FILE } from './helpers/package-manifest.ts'
import { CODE_FONT, SECTION_ICONS, elementOf, sectionOf, styleOf, valueSpan, variableRow } from './helpers/panel-queries.ts'
import { SESSION, envelope } from './helpers/status-envelope.ts'
import type { EnvelopeOptions } from './helpers/status-envelope.ts'

/** The indent an official disclosure body carries to sit under its own title. */
const TITLE_INDENT = 'calc(22px + var(--dsh-content-font-delta, 0px))'

function withHarness(t: TestContext, options: HarnessOptions): Promise<Harness> {
  return createHarness({ sessionId: SESSION, ...options }).then((harness) => {
    t.after(() => {
      harness.dispose()
    })
    return harness
  })
}

/** The panel of an envelope whose value map arrives only when the panel asks for values. */
async function withValues(
  t: TestContext,
  values: Record<string, string>,
  overrides?: EnvelopeOptions['overrides'],
): Promise<{ harness: Harness; panel: number }> {
  const responder = (call: { url: string }) =>
    jsonReply(envelope({ env: call.url.includes('values=1') ? { ...values } : null, ...(overrides ? { overrides } : {}) }))
  const harness = await withHarness(t, { responder })
  const panel = harness.mountPanel()
  await harness.settle()
  return { harness, panel }
}

test('the three sections are official disclosure rows, and none of them is a tag chip', async (t) => {
  const harness = await withHarness(t, { responder: () => jsonReply(envelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const headers: [string, string, boolean][] = [
    [SECTION_ICONS.variables, 'Environment', true],
    [SECTION_ICONS.path, 'PATH', true],
    [SECTION_ICONS.credentials, 'Credential roster', false],
  ]
  for (const [icon, title, open] of headers) {
    const section = sectionOf(harness, panel, icon)
    assert.ok(section !== undefined, `the ${title} section is one official disclosure row`)
    assert.equal(section.props.title, title, `the ${title} header reads as its own title`)
    assert.equal(section.props.expandable, true, `${title} is the disclosure control`)
    assert.equal(section.props.expandOnRowClick, true, `${title} toggles from the whole header row`)
    assert.equal(section.props.open, open, `${title} starts ${open ? 'open' : 'closed'}`)
  }

  // The header is a heading, not a chip: a tag whose whole text is a section
  // title would be the 11px capsule this panel used to wear.
  const chipTexts = harness.primitives(panel, 'Tag').map((instance) => harness.react.textUnder(instance))
  for (const title of ['Environment', 'PATH', 'Credential roster']) {
    assert.ok(!chipTexts.includes(title), `"${title}" is not rendered as a tag chip`)
  }
})

/** The disclosed body one official row rendered, found anywhere under the row. */
function disclosedBody(node: ElementInstance): ElementInstance | null {
  for (const child of node.children) {
    if (child.kind === 'text') continue
    const props = elementOf(child.props)
    if (props !== null && props['data-slot'] === 'body') return child
    const nested = disclosedBody(child)
    if (nested !== null) return nested
  }
  return null
}

/** The indented wrapper the panel puts inside an official row's disclosed body. */
function bodyOf(section: ElementInstance): ElementInstance | null {
  const body = disclosedBody(section)
  if (body === null) return null
  for (const inner of body.children) if (inner.kind !== 'text') return inner
  return null
}

test('a section body is indented under its own title, and one click closes it', async (t) => {
  const harness = await withHarness(t, { responder: () => jsonReply(envelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  for (const icon of [SECTION_ICONS.variables, SECTION_ICONS.path]) {
    const open = sectionOf(harness, panel, icon)
    assert.ok(open !== undefined, `${icon} is rendered`)
    const body = bodyOf(open)
    assert.ok(body !== null, 'an open section renders its body')
    assert.equal(styleOf(body)?.paddingLeft, TITLE_INDENT, 'the body sits under its own title, not beside its icon')
  }

  const section = sectionOf(harness, panel, SECTION_ICONS.path)
  assert.ok(section !== undefined, 'the PATH section is rendered')
  assert.ok(harness.react.textUnder(section).includes('/usr/bin'), 'an open section shows its diff')

  harness.react.clickInside(section)
  const closed = sectionOf(harness, panel, SECTION_ICONS.path)
  assert.ok(closed !== undefined, 'the header survives its own toggle')
  assert.equal(closed.props.open, false, 'clicking the header closes the section')
  assert.ok(!harness.react.textUnder(closed).includes('/usr/bin'), 'and its body leaves the screen with it')
})

test('the credential roster stays closed until the reader opens it', async (t) => {
  const harness = await withHarness(t, { responder: () => jsonReply(envelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const closed = sectionOf(harness, panel, SECTION_ICONS.credentials)
  assert.ok(closed !== undefined, 'the credential section is rendered')
  assert.ok(!harness.react.textUnder(closed).includes('API_TOKEN'), 'a closed roster shows no names')

  harness.react.clickInside(closed)
  const open = sectionOf(harness, panel, SECTION_ICONS.credentials)
  assert.ok(open !== undefined, 'the header survives its own toggle')
  assert.ok(harness.react.textUnder(open).includes('API_TOKEN'), 'opening it lists the credentials')
  const names = harness.react
    .findAll(panel, (instance) => instance.kind !== 'text' && harness.primitiveName(instance.type) === 'Tag')
    .filter((instance) => harness.react.textUnder(instance) === 'API_TOKEN')
  assert.equal(names.length, 1, 'and the name is one official tag')
})

test('the copy button writes the variable value, never its name', async (t) => {
  const { harness, panel } = await withValues(t, { CLIP_ME: 'value-not-name-42' }, {
    variables: [{ name: 'CLIP_ME', sensitive: false, hasValue: true }],
  })

  const row = variableRow(harness, panel, 'CLIP_ME')
  assert.ok(row !== undefined, 'the variable row is rendered')
  harness.react.clickInside(row)
  await harness.settle()

  const copy = harness.primitives(panel, 'Button').find((instance) => instance.props.title === 'Copy value')
  assert.ok(copy !== undefined, 'the expanded row offers the copy control')
  harness.react.click(copy)
  await harness.settle()

  assert.deepEqual(harness.clipboard, ['value-not-name-42'], 'the clipboard received exactly the value')
  assert.ok(!harness.clipboard.includes('CLIP_ME'), 'and never the variable name')
})

test('an expanded row with no value on the wire yet says so, and still offers no copy', async (t) => {
  const harness = await withHarness(t, {
    responder: () => jsonReply(envelope({ overrides: { variables: [{ name: 'EDITOR', sensitive: false, hasValue: true }] } })),
  })
  const panel = harness.mountPanel()
  await harness.settle()

  harness.react.clickInside(variableRow(harness, panel, 'EDITOR')!)
  await harness.settle()

  const span = valueSpan(harness, panel)
  assert.ok(span !== null, 'the value area is rendered')
  assert.equal(
    harness.react.textUnder(span),
    '…',
    'an expanded row says the value has not arrived instead of rendering an empty box',
  )
  assert.equal(
    harness.primitives(panel, 'Button').some((instance) => instance.props.title === 'Copy value'),
    false,
    'and no copy control offers a value that is not there',
  )
  const text = harness.react.textOf(panel)
  for (const placeholder of ['••••', 'Expand any row', 'Values are masked']) {
    assert.ok(!text.includes(placeholder), `the panel renders no "${placeholder}" placeholder`)
  }
})

test('a disclosed value is monospaced through the theme token, and its bytes are untouched', async (t) => {
  const long = 'x'.repeat(300)
  const value = `first line\nsecond\tline  with  spaces\n<not-an-element>\n${long}`
  const { harness, panel } = await withValues(t, { MULTI: value }, {
    variables: [{ name: 'MULTI', sensitive: false, hasValue: true }],
  })

  harness.react.clickInside(variableRow(harness, panel, 'MULTI')!)
  await harness.settle()

  const span = valueSpan(harness, panel)
  assert.ok(span !== null, 'the expanded row renders its value')
  const style = elementOf(span.props.style)
  assert.ok(style !== null, 'the value span carries its style')
  assert.equal(style.font, CODE_FONT, 'the value is drawn in the shell code token, not a typeface of our own')
  assert.equal(style.whiteSpace, 'pre-wrap', 'and wraps without rewriting the bytes')

  const child = span.children[0]
  assert.ok(child !== undefined && child.kind === 'text', 'the value is one text child')
  assert.equal(child.text, value, 'newlines, tabs, repeated spaces and a 300-character line all arrive exactly as sent')
  assert.ok(harness.react.textOf(panel).includes(long), 'a long line is not shortened in JavaScript')
  assert.ok(harness.react.textOf(panel).includes(value), 'and the panel text carries the same bytes')

  const parent = span.parent
  assert.ok(parent !== null, 'the value sits in its own row')
  assert.equal(
    parent.kind === 'text' ? null : styleOf(parent)?.paddingLeft,
    TITLE_INDENT,
    'and that row is indented under the variable name it belongs to',
  )
})

test('an environment byte cannot become an element: markup stays text, and nothing runs', async (t) => {
  const payload = '<img src=x onerror="globalThis.__pwned=1">'
  const name = '<script>__pwned=1</script>'
  const summary = '</pre><img src=x onerror="globalThis.__pwned=1">'
  const { harness, panel } = await withValues(
    t,
    { EVIL: payload, [name]: 'harmless' },
    {
      variables: [
        { name: 'EVIL', sensitive: false, hasValue: true },
        { name, sensitive: true, hasValue: true },
      ],
      errorSummary: summary,
    },
  )
  t.after(() => {
    Reflect.deleteProperty(globalThis, '__pwned')
  })

  harness.react.clickInside(variableRow(harness, panel, 'EVIL')!)
  await harness.settle()

  // (1) No payload became an element: the panel never renders markup from data.
  for (const instance of harness.react.findAll(panel, (candidate) => candidate.kind !== 'text')) {
    if (instance.kind === 'text') continue
    const tag = String(instance.type)
    assert.ok(!['img', 'script', 'pre'].includes(tag), `the payload was not rendered as a <${tag}> element`)
    for (const prop of Object.keys(instance.props)) {
      assert.ok(!/innerhtml|dangerouslysetinnerhtml|srcdoc/i.test(prop), `no element carries the ${prop} sink`)
    }
  }

  // (2) The bytes are on screen as text, verbatim.
  const text = harness.react.textOf(panel)
  assert.ok(text.includes(payload), 'the value payload is rendered as text')
  assert.ok(text.includes(name), 'the variable-name payload is rendered as text')
  assert.ok(text.includes(summary), 'the error-summary payload is rendered as text')

  const span = valueSpan(harness, panel)
  assert.ok(span !== null, 'the value span is rendered')
  const child = span.children[0]
  assert.equal(child !== undefined && child.kind === 'text' ? child.text : '', payload, 'the value is one text child')

  // (3) Nothing executed.
  assert.equal(Reflect.get(globalThis, '__pwned'), undefined, 'no handler ran')
})

test('the artifact reaches the DOM only through react children', () => {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  for (const sink of [
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'dangerouslySetInnerHTML',
    'document.write',
    'new Function',
    'eval(',
  ]) {
    assert.ok(!source.includes(sink), `the artifact carries no ${sink}`)
  }
})
