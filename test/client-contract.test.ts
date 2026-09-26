/**
 * The client/host contract for `client.js`, run against the real module.
 *
 * `test/host.test.ts` covers the host modules and `test/client-boot.ts` covers
 * the delivery of the bundle; neither one would notice a client that reads the
 * status route's *envelope* as if it were the record. That is the bug this file
 * exists to catch: `GET /plugins/dsh-direnv/status.json` answers
 * `{ ok, plugin, sessionId, dir, status, gate, config }` (src/status-route.ts),
 * so a reader that looks for `payload.state` finds nothing, throws
 * "unexpected payload shape" on every poll, and leaves the panel empty forever.
 *
 * The fixture below copies the shapes the host really sends, including the
 * `status: null` branch for a session with no known directory, and the harness
 * mounts the real component tree (see test/helpers/client-harness.ts).
 */
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { brokenJsonReply, createHarness, errorReply, jsonReply, spaFallbackReply } from './helpers/client-harness.ts'
import type { Harness, HarnessOptions } from './helpers/client-harness.ts'
import type { ElementInstance, Instance } from './helpers/fake-react.ts'
import { isRecord } from './helpers/guards.ts'
import { CLIENT_FILE, REPO } from './helpers/package-manifest.ts'
import { ROW_ICON, SECTION_ICONS, elementOf, sectionOf, variableRow } from './helpers/panel-queries.ts'
import {
  AT,
  DIR,
  PATH_ENTRIES,
  SESSION,
  VALUES,
  envelope,
  flatRecord,
  noWorkspaceEnvelope,
} from './helpers/status-envelope.ts'

function withHarness(t: TestContext, options: HarnessOptions): Promise<Harness> {
  return createHarness({ sessionId: SESSION, ...options }).then((harness) => {
    t.after(() => {
      harness.dispose()
    })
    return harness
  })
}

/**
 * The official primitives the module table's seed list answers. The bundle may
 * name a specifier outside this list only by white-screening the whole web app,
 * so the artifact is scanned for every one of them below.
 */
const SEED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** The official component the panel rendered for one path, or null when it rendered none. */
function pathLabelOf(harness: Harness, panel: number, path: string): ElementInstance | null {
  return harness.primitives(panel, 'PathLabel').find((instance) => instance.props.path === path) ?? null
}

/** The nearest ancestor (or the node itself) that is one official primitive. */
function ancestorPrimitive(harness: Harness, node: Instance, name: string): ElementInstance | null {
  let current: Instance | null = node
  while (current !== null) {
    if (current.kind !== 'text' && harness.primitiveName(current.type) === name) return current
    current = current.parent
  }
  return null
}

/** Whether one official primitive is rendered anywhere under a node. */
function containsPrimitive(harness: Harness, node: Instance, name: string): boolean {
  if (node.kind !== 'text' && harness.primitiveName(node.type) === name) return true
  return node.children.some((child) => containsPrimitive(harness, child, name))
}

/** Every `Tag` whose own text carries a fragment, in tree order. */
function tagsWithText(harness: Harness, panel: number, fragment: string): ElementInstance[] {
  return harness.primitives(panel, 'Tag').filter((instance) => harness.react.textUnder(instance).includes(fragment))
}

test('a real host envelope renders the panel instead of "status unavailable"', async (t) => {
  const harness = await withHarness(t, { responder: () => jsonReply(envelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const text = harness.react.textOf(panel)
  assert.ok(harness.fetchCalls.length > 0, 'the panel polled the status route')
  assert.match(harness.fetchCalls[0]!.url, /^\/plugins\/dsh-direnv\/status\.json\?sessionId=session-contract/)

  // Every section the fixture carries is on screen: names, the PATH diff,
  // credential roster, and the resolved directory.
  for (const name of ['API_TOKEN', 'EDITOR', 'PATH']) {
    assert.ok(text.includes(name), `variable ${name} is rendered`)
  }
  for (const entry of PATH_ENTRIES) {
    assert.ok(text.includes(entry.value), `the PATH entry ${entry.value} is rendered`)
  }
  assert.ok(text.includes('API_TOKEN'), 'the credential roster is rendered')
  assert.ok(text.includes(DIR), 'the resolved directory is rendered')
  assert.ok(text.includes('3 entries'), 'the variable count is rendered')

  // The status is one official dot plus one official tag, never a hand-drawn pill.
  assert.equal(harness.primitives(panel, 'StateDot')[0]?.props.state, 'done', 'a ready workspace is the done dot')
  assert.equal(tagsWithText(harness, panel, 'Ready')[0]?.props.tone, 'success', 'and it wears the success tone')

  // The variable count rides one official pill, and the updated time one
  // official tooltip: labelled with the host clock, portaled, and rendering the
  // relative age as the child it was handed.
  assert.equal(harness.primitives(panel, 'Pill')[0]?.props.children, '3 entries', 'the count is one official pill')
  const age = harness.primitives(panel, 'Tooltip').find((tip) => tip.props.label === new Date(AT).toLocaleTimeString())
  assert.ok(age !== undefined, 'the updated time is an official tooltip labelled with the host clock')
  assert.equal(age.props.portal, true, 'the tooltip asks for the body portal')
  const ageText = harness.react.textUnder(age)
  assert.ok(ageText !== '' && harness.react.textOf(panel).includes(ageText), 'the tooltip renders the age as its child')

  // The failure signature of the envelope bug: no route-down pill, no transport
  // error in the footer.
  assert.ok(!text.includes('Status unavailable'), 'the panel does not report the status route as down')
  assert.ok(!text.includes('状态不可用'), 'the panel does not report the status route as down (zh)')
  assert.ok(!text.includes('unexpected payload shape'), 'no shape error leaked into the panel')
  assert.deepEqual(harness.errorLines, [], 'the client logged no internal error')
})

test('each PATH transition renders as one official tag, in host order, marked without colour', async (t) => {
  const harness = await withHarness(t, { responder: () => jsonReply(envelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const TONES: Record<string, string> = { added: 'success', removed: 'danger', unchanged: 'neutral' }
  const MARKS: Record<string, string | null> = {
    added: 'IconPlusOutlineRegular',
    removed: 'IconCloseOutlineRegular',
    unchanged: null,
  }

  for (const entry of PATH_ENTRIES) {
    const label = pathLabelOf(harness, panel, entry.value)
    assert.ok(label !== null, `the panel renders ${entry.value} through the official PathLabel`)
    const tag = ancestorPrimitive(harness, label, 'Tag')
    assert.ok(tag !== null, `${entry.value} is rendered inside an official tag`)
    assert.equal(tag.props.tone, TONES[entry.change], `a ${entry.change} entry takes the ${String(TONES[entry.change])} tone`)
    // Removal has to stay readable without colour, so each changed state carries
    // its own official icon and an unchanged entry carries neither.
    const mark = MARKS[entry.change] ?? null
    for (const candidate of ['IconPlusOutlineRegular', 'IconCloseOutlineRegular']) {
      assert.equal(
        containsPrimitive(harness, tag, candidate),
        mark === candidate,
        `a ${entry.change} entry ${mark === candidate ? 'carries' : 'carries no'} ${candidate}`,
      )
    }
  }

  const rendered = harness.primitives(panel, 'PathLabel')
    .map((instance) => String(instance.props.path))
    .filter((path) => PATH_ENTRIES.some((entry) => entry.value === path))
  assert.deepEqual(rendered, PATH_ENTRIES.map((entry) => entry.value), 'the host order is preserved: earlier means higher priority')

  const section = sectionOf(harness, panel, SECTION_ICONS.path)
  assert.ok(section !== undefined, 'the diff is the body of the PATH section header')
  assert.equal(section.props.open, true, 'and the section starts open, so the diff is on screen without a click')
  assert.ok(
    PATH_ENTRIES.every((entry) => harness.react.textUnder(section).includes(entry.value)),
    'every entry renders inside that one section',
  )
})

test('a long path reaches the official PathLabel whole, and nothing shortens it in JavaScript', async (t) => {
  const longDir = `${DIR}/${'deep/'.repeat(20)}workspace`
  const longBin = `${longDir}/bin`
  const longEnvrc = `${longDir}/.envrc`
  const harness = await withHarness(t, {
    responder: () =>
      jsonReply(
        envelope({
          overrides: {
            dir: longDir,
            envrcPath: longEnvrc,
            pathEntries: [{ value: longBin, change: 'added' }],
          },
        }),
      ),
  })
  const panel = harness.mountPanel()
  await harness.settle()

  const text = harness.react.textOf(panel)
  assert.ok(text.includes(longBin), 'the PATH row carries all 126 characters, not a middle-ellipsized stub')
  assert.ok(text.includes(longDir), 'the directory row carries the whole path')
  assert.ok(text.includes(longEnvrc), 'the .envrc row carries the whole path')
  assert.ok(!text.includes('\u2026'), 'no path was cut in JavaScript')

  // The panel's share of the contract is the value it hands over: PathLabel owns
  // the fit, and its own `title` (mirrored by the stub) is where the whole path
  // stays reachable when the sidebar is too narrow to draw it.
  const fields: [string, string][] = [
    ['directory', longDir],
    ['envrc', longEnvrc],
    ['PATH entry', longBin],
  ]
  for (const [label, value] of fields) {
    const rendered = pathLabelOf(harness, panel, value)
    assert.ok(rendered !== null, `the ${label} is rendered by the official PathLabel`)
    assert.equal(rendered.props.path, value, `PathLabel receives the whole ${label}`)
    const host = rendered.children[0]
    assert.ok(host !== undefined && host.kind !== 'text' && host.props.title === value, `the whole ${label} stays on hover`)
  }
})

test('an empty PATH component names the current directory instead of reading as "no content"', async (t) => {
  const harness = await withHarness(t, {
    responder: () => jsonReply(envelope({ overrides: { pathEntries: [{ value: '', change: 'added' }] } })),
  })
  const panel = harness.mountPanel()
  await harness.settle()

  const rows = tagsWithText(harness, panel, '(empty → current directory)')
  assert.equal(rows.length, 1, 'the empty component still renders its own PATH row')
  assert.equal(rows[0]!.props.tone, 'success', 'and it keeps the tone of its own transition')
  assert.equal(pathLabelOf(harness, panel, ''), null, 'an empty component is not handed to PathLabel, which would draw nothing')
  const text = harness.react.textOf(panel)
  assert.ok(text.includes('(empty → current directory)'), 'the empty component says what POSIX gives it: the current directory')
  assert.ok(!text.includes('(empty)'), 'the old "this entry has no content" reading is gone')
})

test('an unset PATH is announced in the PATH card, an untouched PATH stays silent', async (t) => {
  const harness = await withHarness(t, {
    responder: () =>
      jsonReply(
        envelope({
          overrides: {
            variables: [
              { name: 'EDITOR', sensitive: false, hasValue: true },
              { name: 'PATH', sensitive: false, hasValue: false },
            ],
            pathEntries: [],
          },
        }),
      ),
  })
  const panel = harness.mountPanel()
  await harness.settle()

  const section = sectionOf(harness, panel, SECTION_ICONS.path)
  assert.ok(section !== undefined, 'the `unset PATH` tombstone is reported in the PATH card')
  assert.ok(
    harness.react.textUnder(section).includes('PATH was removed by this .envrc'),
    'the tombstone is the open PATH section body',
  )

  // The same empty diff without a tombstone must stay silent: "PATH did not
  // change" is not "PATH was removed".
  harness.respond(() =>
    jsonReply(
      envelope({
        overrides: { variables: [{ name: 'EDITOR', sensitive: false, hasValue: true }], pathEntries: [] },
      }),
    ),
  )
  harness.tick()
  await harness.settle()

  const text = harness.react.textOf(panel)
  assert.ok(!text.includes('PATH was removed by this .envrc'), 'an untouched PATH is never reported as removed')
  assert.equal(
    sectionOf(harness, panel, SECTION_ICONS.path),
    undefined,
    'no PATH card is rendered without a diff or a tombstone',
  )
})

test('no hide/show control survives, in either language', async (t) => {
  const harness = await withHarness(t, { responder: () => jsonReply(envelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const buttons = harness.primitives(panel, 'Button')
  assert.equal(buttons.length, 1, 'the status card now has exactly one action: reload')
  const reload = buttons[0]!
  assert.equal(reload.props.variant, 'outline', 'the reload action is an official button, not a hand-drawn one')
  assert.equal(reload.props.disabled, false, 'and it is live while no reload is in flight')
  const text = harness.react.textUnder(reload)
  assert.ok(text.includes('Reload'), 'the surviving button is the reload action')
  for (const gone of ['Hide this panel', 'Show the panel again', 'Panel hidden in this session', 'Polling paused']) {
    assert.ok(!harness.react.textOf(panel).includes(gone), `the panel no longer renders "${gone}"`)
  }
})

test('a flat record body still renders, so the reader tolerates both shapes', async (t) => {
  const harness = await withHarness(t, { responder: () => jsonReply(flatRecord()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const text = harness.react.textOf(panel)
  assert.ok(text.includes('EDITOR'), 'variable names are rendered from a flat body')
  assert.ok(text.includes(DIR), 'the directory is rendered from a flat body')
  assert.ok(!text.includes('Status unavailable'), 'a flat body is not a transport failure')
})

test('status: null is "no workspace information yet", not a transport failure', async (t) => {
  const harness = await withHarness(t, { responder: () => jsonReply(noWorkspaceEnvelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const text = harness.react.textOf(panel)
  assert.ok(harness.fetchCalls.length > 0, 'the host was polled')
  assert.ok(text.includes('no workspace directory for this session yet'), 'the panel explains the host has no workspace yet')
  assert.ok(!text.includes('Status unavailable'), 'status:null is not reported as a route failure')
  assert.ok(!text.includes('状态不可用'), 'status:null is not reported as a route failure (zh)')
  assert.equal(harness.blocks.current(SESSION), undefined, 'a session without a workspace never blocks the composer')
  assert.deepEqual(harness.errorLines, [])
})

test('a loading envelope blocks the composer, and the ok envelope releases it', async (t) => {
  let body = envelope({ state: 'loading' })
  const harness = await withHarness(t, { responder: () => jsonReply(body) })
  harness.mountPanel()
  await harness.settle()

  assert.deepEqual(harness.blocks.current(SESSION), { reason: 'direnv: loading .envrc…' }, 'the loading state blocks the composer')

  body = envelope()
  harness.tick()
  await harness.settle()
  assert.equal(harness.blocks.current(SESSION), undefined, 'reaching ok releases the composer')
})

test('expanding a row asks the host for values, and collapsing stops asking', async (t) => {
  const responder = (call: { url: string }) =>
    jsonReply(envelope({ env: call.url.includes('values=1') ? { ...VALUES } : null }))
  const harness = await withHarness(t, { responder })
  const panel = harness.mountPanel()
  await harness.settle()

  assert.ok(!harness.lastUrl()!.includes('values=1'), 'the default poll does not pull secret values')
  // The first disclosure row on screen is the section header; values are fetched
  // for a variable row, so the click has to land on one.
  const row = variableRow(harness, panel, 'EDITOR')
  assert.ok(row !== undefined, 'the variable list rendered a disclosure row')

  harness.react.clickInside(row)
  await harness.settle()
  assert.ok(harness.lastUrl()!.includes('values=1'), 'expanding a row adds values=1 to the poll')
  assert.ok(harness.react.textOf(panel).includes('vim'), 'the expanded row shows the value the host sent')

  harness.react.clickInside(variableRow(harness, panel, 'EDITOR')!)
  await harness.settle()
  harness.tick()
  await harness.settle()
  assert.ok(!harness.lastUrl()!.includes('values=1'), 'collapsing every row stops asking for values')
})

test('a variable row discloses on the official row, and the copy button writes the value', async (t) => {
  const responder = (call: { url: string }) =>
    jsonReply(envelope({ env: call.url.includes('values=1') ? { ...VALUES } : null }))
  const harness = await withHarness(t, { responder })
  const panel = harness.mountPanel()
  await harness.settle()

  const row = variableRow(harness, panel, 'EDITOR')
  assert.ok(row !== undefined, 'each variable is one official disclosure row')
  assert.equal(row.props.expandable, true, 'the row is the disclosure control')
  assert.equal(row.props.open, false, 'and it starts closed')
  assert.ok(!harness.react.textOf(panel).includes('vim'), 'a closed row keeps the value off screen')

  harness.react.clickInside(row)
  await harness.settle()
  assert.ok(harness.react.textOf(panel).includes('vim'), 'the open row shows the value')

  const copy = harness.primitives(panel, 'Button').find((instance) => instance.props.title === 'Copy value')
  assert.ok(copy !== undefined, 'the open row offers the official copy action, labelled as copying the value')
  const copyIcon: unknown = copy.props.icon
  assert.ok(isRecord(copyIcon), 'the button carries an icon element')
  assert.equal(harness.primitiveName(copyIcon.type), 'IconCopyOutlineRegular', 'which starts as the copy glyph')
  harness.react.click(copy)
  await harness.settle()
  assert.deepEqual(harness.clipboard, ['vim'], 'the value, and only the value, went to the official clipboard')
  const acknowledged = harness.primitives(panel, 'Button').find((instance) => instance.props.title === 'Copied')
  assert.ok(acknowledged !== undefined, 'the copy is acknowledged on the button itself')
  const checkIcon: unknown = acknowledged.props.icon
  assert.ok(isRecord(checkIcon), 'the acknowledgement is an icon too')
  assert.equal(
    harness.primitiveName(checkIcon.type),
    'IconCheckOutlineRegular',
    'by the official check glyph, not a hand-drawn colour',
  )
})

test('the variable search field is the official input, and it filters the rows', async (t) => {
  const many = ['EDITOR', 'FOO', 'GIT_PAGER', 'LESS', 'MANPAGER', 'PAGER', 'TERM'].map((name) => ({
    name,
    sensitive: false,
    hasValue: true,
  }))
  const harness = await withHarness(t, { responder: () => jsonReply(envelope({ overrides: { variables: many } })) })
  const panel = harness.mountPanel()
  await harness.settle()

  const search = harness.primitives(panel, 'Input')[0]
  assert.ok(search !== undefined, 'more than six variables bring up the official search input')
  assert.equal(search.props.type, 'search', 'and it is a search field')
  const field = harness.react.findAll(panel, (instance) => instance.kind === 'host' && instance.type === 'input')[0]
  assert.ok(field !== undefined && field.kind !== 'text', 'the input renders a native field')
  const onChange = field.props.onChange
  assert.equal(typeof onChange, 'function', 'and the panel listens to it')
  ;(onChange as (event: unknown) => void)({ target: { value: 'edit' } })
  harness.react.flush()

  // The section headers are disclosure rows too, so the surviving rows are read
  // off the glyph only a variable row carries.
  const rows = harness.primitives(panel, 'DisclosureRow').filter((instance) => {
    const element = elementOf(instance.props.icon)
    return element !== null && harness.primitiveName(element.type) === ROW_ICON
  })
  assert.deepEqual(rows.map((instance) => String(instance.props.title)), ['EDITOR'], 'only the matching variable row survives the filter')
  assert.equal(harness.primitives(panel, 'Input')[0]?.props.value, 'edit', 'the field stays controlled by the panel')
})

test('a blocked workspace shows its summary and warnings through official tags', async (t) => {
  const harness = await withHarness(t, {
    responder: () =>
      jsonReply(
        envelope({
          state: 'blocked',
          overrides: {
            errorSummary: `${DIR}/.envrc is blocked. Run \`direnv allow\` to approve its content`,
            warnings: ['direnv 2.37.1 is older than this plugin expects'],
          },
        }),
      ),
  })
  const panel = harness.mountPanel()
  await harness.settle()

  const text = harness.react.textOf(panel)
  assert.ok(text.includes('direnv allow'), 'the actionable summary reaches the panel whole')
  assert.ok(text.includes('direnv 2.37.1 is older'), 'and so does every warning')
  assert.equal(harness.primitives(panel, 'StateDot')[0]?.props.state, 'warning', '`blocked` is amber, not a failure')
  assert.equal(tagsWithText(harness, panel, 'Error summary')[0]?.props.tone, 'danger', 'the summary is labelled as a failure')
  assert.equal(tagsWithText(harness, panel, 'Warnings')[0]?.props.tone, 'warning', 'the warnings carry the attention tone')
})

test('hostile responses stay silent: no throw, no false toast, no blocked input', async (t) => {
  let reply = errorReply(404)
  const harness = await withHarness(t, { responder: () => reply })
  const panel = harness.mountPanel()
  await harness.settle()

  assert.ok(harness.react.textOf(panel).includes('Status unavailable'), 'a 404 reads as a route-down panel')
  assert.equal(tagsWithText(harness, panel, 'Status unavailable')[0]?.props.tone, 'danger', 'and the notice is a danger tag')
  assert.equal(harness.primitives(panel, 'StateDot')[0]?.props.state, 'error', 'with the error dot beside it')
  assert.equal(harness.blocks.current(SESSION), undefined, 'a 404 never blocks the composer')
  assert.deepEqual(harness.notifications, [], 'a 404 raises no failure toast')
  assert.deepEqual(harness.errorLines, [], 'a 404 logs no internal error')

  reply = spaFallbackReply()
  harness.tick()
  await harness.settle()
  assert.ok(!harness.react.textOf(panel).includes('<!doctype html>'), 'the SPA fallback is never parsed as a status')
  assert.equal(harness.blocks.current(SESSION), undefined, 'the SPA fallback never blocks the composer')
  assert.deepEqual(harness.notifications, [], 'the SPA fallback raises no failure toast')

  reply = brokenJsonReply()
  harness.tick()
  await harness.settle()
  assert.ok(harness.react.textOf(panel).includes('Status unavailable'), 'garbage JSON reads as a route-down panel')
  assert.equal(harness.blocks.current(SESSION), undefined, 'garbage JSON never blocks the composer')
  assert.deepEqual(harness.notifications, [], 'garbage JSON raises no failure toast')
  assert.deepEqual(harness.errorLines, [], 'garbage JSON logs no internal error')

  // A later good answer recovers the panel without a remount.
  harness.respond(() => jsonReply(envelope()))
  harness.tick()
  await harness.settle()
  assert.ok(harness.react.textOf(panel).includes('EDITOR'), 'a later good answer repaints the panel')
})

test('a composer block another plugin owns is left untouched', async (t) => {
  let body = envelope({ state: 'loading' })
  const harness = await withHarness(t, { responder: () => jsonReply(body) })
  harness.blocks.set(SESSION, { reason: 'no model can route this prompt' })

  harness.mountPanel()
  await harness.settle()
  assert.deepEqual(
    harness.blocks.current(SESSION),
    { reason: 'no model can route this prompt' },
    'the loading state does not steal an occupied composer block',
  )
  assert.ok(
    harness.debugLines.some((line) => line.includes('another plugin')),
    'the skipped block is reported through console.debug',
  )

  harness.tick()
  await harness.settle()
  assert.equal(
    harness.debugLines.filter((line) => line.includes('another plugin')).length,
    1,
    'the skip is reported once, not on every poll',
  )

  body = envelope()
  harness.tick()
  await harness.settle()
  assert.deepEqual(
    harness.blocks.current(SESSION),
    { reason: 'no model can route this prompt' },
    'reaching ok does not clear a block this plugin never raised',
  )
})

test('a problem state raises one failure toast through the session input shell', async (t) => {
  const harness = await withHarness(t, {
    responder: () =>
      jsonReply(
        envelope({
          state: 'blocked',
          overrides: { errorSummary: `${DIR}/.envrc is blocked. Run \`direnv allow\` to approve its content` },
        }),
      ),
  })
  harness.mountDock()
  await harness.settle()

  assert.equal(harness.notifications.length, 1, 'exactly one toast for one problem')
  assert.equal(harness.notifications[0]!.level, 'error')
  assert.ok(harness.notifications[0]!.text.includes('direnv allow'), 'the toast carries the actionable copy')

  harness.tick()
  await harness.settle()
  assert.equal(harness.notifications.length, 1, 'the same problem is not announced again')
})

test('the Chinese table is what a zh locale service shows, and the hide copy is gone', async (t) => {
  const harness = await withHarness(t, { locale: 'zh', responder: () => jsonReply(envelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const text = harness.react.textOf(panel)
  assert.ok(text.includes('已就绪'), 'the zh state label is rendered')
  assert.ok(text.includes('PATH 条目'), 'the zh PATH section title is rendered')
  for (const gone of ['靠前的条目优先级更高', '展开任意一行以获取变量值', '值默认遮蔽为', '展开行后点击复制按钮']) {
    assert.ok(!text.includes(gone), `the panel no longer renders the hint "${gone}"`)
  }
  assert.ok(!text.includes('本工作区禁用'), 'the old "disable in this workspace" claim is gone')
  assert.ok(!text.includes('exposeValues'), 'no copy points at a configuration key the host does not have')
  for (const gone of ['本会话隐藏面板', '恢复显示面板', '已在本浏览器隐藏', '已暂停轮询']) {
    assert.ok(!text.includes(gone), `the panel no longer renders "${gone}"`)
  }
})

test('the three message tables stay in sync, and the dead keys stay deleted', () => {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  const readJson = (name: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(REPO, 'locale', name), 'utf8'))
    if (!isRecord(parsed)) throw new Error(`locale/${name} is not an object`)
    return parsed
  }

  const flatten = (value: Record<string, unknown>, prefix = ''): Set<string> => {
    const keys = new Set<string>()
    for (const [key, item] of Object.entries(value)) {
      const full = prefix === '' ? key : `${prefix}.${key}`
      if (isRecord(item) && !Array.isArray(item)) {
        for (const nested of flatten(item, full)) keys.add(nested)
      } else {
        keys.add(full)
      }
    }
    return keys
  }

  const inlineKeys = (name: string): Set<string | undefined> => {
    const start = source.indexOf(`const ${name} = {`)
    assert.notEqual(start, -1, `the client artifact carries an inline ${name} table`)
    const end = source.indexOf('\n    }', start)
    const section = source.slice(start, end)
    return new Set(
      [...section.matchAll(/^ {6}(?:'([^']+)'|"([^"]+)"|([A-Za-z][\w.-]*)):/gm)].map(
        (match) => match[1] ?? match[2] ?? match[3],
      ),
    )
  }

  const inlineZh = inlineKeys('zh')
  const inlineEn = inlineKeys('en')
  const jsonZh = flatten(readJson('zh.json'))
  const jsonEn = flatten(readJson('en.json'))

  const sorted = (set: Set<string | undefined>): (string | undefined)[] => [...set].sort()
  assert.deepEqual(sorted(inlineZh), sorted(jsonZh), 'the inline zh table matches locale/zh.json')
  assert.deepEqual(sorted(inlineEn), sorted(jsonEn), 'the inline en table matches locale/en.json')
  assert.deepEqual(sorted(inlineZh), sorted(inlineEn), 'the two inline tables carry the same keys')

  const tables: [string, Set<string | undefined>][] = [
    ['inline zh', inlineZh],
    ['inline en', inlineEn],
    ['locale/zh.json', jsonZh],
    ['locale/en.json', jsonEn],
  ]
  const deleted = [
    'label.state',
    'label.pathAdditions',
    'action.disable',
    'action.enable',
    'action.reveal',
    'action.hide',
    'action.copyName',
    'hint.hidden',
    'hint.paused',
    'hint.pathOrder',
    'hint.masked',
    'hint.noValues',
    'hint.copyHint',
    'hint.empty',
    'hint.credentials',
  ]
  for (const [label, keys] of tables) {
    for (const key of deleted) {
      assert.ok(!keys.has(key), `${label} no longer carries the dead ${key} key`)
    }
    for (const key of [
      'action.copyValue',
      'hint.pathEmpty',
      'hint.pathUnset',
      'hint.valuePending',
      'hint.valueUnset',
      'hint.valueRemoved',
      // The official relative-time buckets hand over no words of their own.
      'time.now',
      'time.minutes',
      'time.hours',
      'time.days',
      'time.months',
      'time.years',
    ]) {
      assert.ok(keys.has(key), `${label} carries ${key}`)
    }
    assert.equal(keys.size, 58, `${label} is 58 keys wide`)
  }
})

test('the artifact requires nothing outside the client module table seed list', () => {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  const specifiers = [...source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g)].map((match) => match[2])

  // A specifier the table cannot answer throws inside the plugin factory, which
  // is a white-screened web app rather than a quiet panel: every call site has to
  // be scanned, not just the one this test happens to know about.
  assert.ok(specifiers.length >= 2, 'the artifact still reaches the host module table')
  for (const specifier of specifiers) {
    assert.ok(SEED_MODULES.has(specifier!), `${specifier} is part of the module table's seed list`)
  }
  assert.ok(specifiers.includes('react'), 'the artifact loads react from the table')
  assert.ok(specifiers.includes('@deepseek-ai/dsh-client-ui-primitives'), 'and the official primitives')
})
