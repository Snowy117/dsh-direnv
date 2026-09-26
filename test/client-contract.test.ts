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
import { isRecord } from './helpers/guards.ts'
import { CLIENT_FILE, REPO } from './helpers/package-manifest.ts'

const SESSION = 'session-contract'
const DIR = '/work/ws-contract'

const VARIABLES = [
  { name: 'API_TOKEN', sensitive: true, hasValue: true },
  { name: 'EDITOR', sensitive: false, hasValue: true },
  { name: 'PATH', sensitive: false, hasValue: true },
]
const VALUES = { API_TOKEN: 'tok-live-123', EDITOR: 'vim', PATH: '/work/ws-contract/bin:/usr/bin' }

interface EnvelopeStatus {
  dir: string
  state: string
  at: number
  ms: number
  envrcPath: string
  memoHit: boolean
  watchCount: number
  variables: { name: string; sensitive: boolean; hasValue: boolean }[]
  pathAdditions: string[]
  credentials: string[]
  errorSummary: string | null
  warnings: string[]
  env: Record<string, string> | null
}

interface Envelope {
  ok: boolean
  plugin: { name: string; version: string }
  sessionId: string
  dir: string
  status: EnvelopeStatus
  gate: { dir: string; state: string; result: string; elapsedMs: number }
  config: { disabledDirs: string[]; loadTimeoutMs: number }
}

interface EnvelopeOptions {
  state?: string
  env?: Record<string, string> | null
  overrides?: Partial<EnvelopeStatus>
}

/**
 * The exact envelope `src/status-route.ts` answers for a known directory:
 * the record is nested under `status`, and `ok` / `plugin` / `sessionId` / `dir`
 * / `gate` / `config` sit beside it.
 */
function envelope({ state = 'ok', env = null, overrides = {} }: EnvelopeOptions = {}): Envelope {
  return {
    ok: true,
    plugin: { name: 'dsh-direnv', version: '0.1.0' },
    sessionId: SESSION,
    dir: DIR,
    status: {
      dir: DIR,
      state,
      at: 1_737_000_000_000,
      ms: 1234,
      envrcPath: `${DIR}/.envrc`,
      memoHit: true,
      watchCount: 2,
      variables: VARIABLES.map((variable) => ({ ...variable })),
      pathAdditions: ['/nix/store/abcd1234-nix-direnv/bin', '/work/ws-contract/bin'],
      credentials: ['API_TOKEN'],
      errorSummary: null,
      warnings: [],
      env,
      ...overrides,
    },
    gate: { dir: DIR, state: 'released', result: 'ok', elapsedMs: 12 },
    config: { disabledDirs: [], loadTimeoutMs: 300_000 },
  }
}

/** The host's other 200: a session with no directory it can resolve. */
function noWorkspaceEnvelope() {
  return { ok: true, plugin: { name: 'dsh-direnv', version: '0.1.0' }, sessionId: SESSION, dir: null, status: null, gate: null }
}

/** A record with the envelope stripped off, which the reader must still accept. */
function flatRecord(options?: EnvelopeOptions): EnvelopeStatus {
  return envelope(options).status
}

function withHarness(t: TestContext, options: HarnessOptions): Promise<Harness> {
  return createHarness({ sessionId: SESSION, ...options }).then((harness) => {
    t.after(() => {
      harness.dispose()
    })
    return harness
  })
}

test('a real host envelope renders the panel instead of "status unavailable"', async (t) => {
  const harness = await withHarness(t, { responder: () => jsonReply(envelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const text = harness.react.textOf(panel)
  assert.ok(harness.fetchCalls.length > 0, 'the panel polled the status route')
  assert.match(harness.fetchCalls[0]!.url, /^\/plugins\/dsh-direnv\/status\.json\?sessionId=session-contract/)

  // Every section the fixture carries is on screen: names, PATH additions,
  // credential roster, and the resolved directory.
  for (const name of ['API_TOKEN', 'EDITOR', 'PATH']) {
    assert.ok(text.includes(name), `variable ${name} is rendered`)
  }
  assert.ok(text.includes('/nix/store/abcd1234-nix-direnv/bin'), 'PATH additions are rendered')
  assert.ok(text.includes('/work/ws-contract/bin'), 'every PATH addition is rendered')
  assert.ok(text.includes('API_TOKEN'), 'the credential roster is rendered')
  assert.ok(text.includes(DIR), 'the resolved directory is rendered')
  assert.ok(text.includes('3 entries'), 'the variable count is rendered')

  // The failure signature of the envelope bug: no route-down pill, no transport
  // error in the footer.
  assert.ok(!text.includes('Status unavailable'), 'the panel does not report the status route as down')
  assert.ok(!text.includes('状态不可用'), 'the panel does not report the status route as down (zh)')
  assert.ok(!text.includes('unexpected payload shape'), 'no shape error leaked into the panel')
  assert.deepEqual(harness.errorLines, [], 'the client logged no internal error')
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
  let row = harness.react.findByClass(panel, 'dsh-direnv-row')
  assert.ok(row !== null, 'the variable list rendered a row')

  harness.react.click(row)
  await harness.settle()
  assert.ok(harness.lastUrl()!.includes('values=1'), 'expanding a row adds values=1 to the poll')
  assert.ok(harness.react.textOf(panel).includes('tok-live-123'), 'the revealed row shows the original value')

  row = harness.react.findByClass(panel, 'dsh-direnv-row')
  harness.react.click(row!)
  await harness.settle()
  harness.tick()
  await harness.settle()
  assert.ok(!harness.lastUrl()!.includes('values=1'), 'collapsing every row stops asking for values')
})

test('hostile responses stay silent: no throw, no false toast, no blocked input', async (t) => {
  let reply = errorReply(404)
  const harness = await withHarness(t, { responder: () => reply })
  const panel = harness.mountPanel()
  await harness.settle()

  assert.ok(harness.react.textOf(panel).includes('Status unavailable'), 'a 404 reads as a route-down panel')
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

test('the Chinese table is what a zh locale service shows, with the honest hide copy', async (t) => {
  const harness = await withHarness(t, { locale: 'zh', responder: () => jsonReply(envelope()) })
  const panel = harness.mountPanel()
  await harness.settle()

  const text = harness.react.textOf(panel)
  assert.ok(text.includes('已就绪'), 'the zh state label is rendered')
  assert.ok(text.includes('本会话隐藏面板'), 'the hide action names what it really does')
  assert.ok(!text.includes('本工作区禁用'), 'the old "disable in this workspace" claim is gone')
  assert.ok(text.includes('展开任意一行以获取变量值'), 'the zh value hint points at expanding a row')
  assert.ok(!text.includes('exposeValues'), 'no copy points at a configuration key the host does not have')
})

test('the three message tables stay in sync, and label.state stays deleted', () => {
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
  for (const [label, keys] of tables) {
    assert.ok(!keys.has('label.state'), `${label} no longer carries the dead label.state key`)
  }
})
