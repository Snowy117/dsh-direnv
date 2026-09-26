/**
 * The right-column panel: the status card, the environment sections and the
 * footer. It renders whatever the last poll answered and never blocks: a poll in
 * flight leaves the previous answer on screen, and a failed poll says so in the
 * footer instead of emptying the panel.
 *
 * Every block here is an official primitive (`client/primitives.ts`), or plain
 * text where the shell's own type is the right one; the panel owns no color,
 * radius, border, shadow or font, so an installed theme restyles it together
 * with the rest of the shell. Paths are never shortened in JavaScript:
 * `PathLabel` renders the whole string, fades it at the left edge when the
 * sidebar is too narrow, and keeps the complete value in its own `title`, which
 * is the one hover a path needs. Status becomes exactly one dot state and one
 * tag tone — see `STATE_FACES`, the only place a host state turns into an
 * official semantic.
 *
 * The keyed seats this component fills are registered in `index.ts`; the key
 * there is the tab type's `id`, because a `kind` key silently renders nothing.
 */

import { POLL_MS } from './constants.ts'
import { firstLine, formatClock, formatMs } from './format.ts'
import type { StatusHub, StatusState } from './hub.ts'
import type { Translate } from './messages.ts'
import type { DotState, TagTone } from './primitives.ts'
import { ui } from './primitives.ts'
import { h, fragment, useEffect, useState } from './react.ts'
import { L } from './styles.ts'
import { Credentials, EnvDetails, PathEntries, pathWasRemoved } from './env-details.ts'

export interface PanelProps {
  sessionId: string | undefined
  t: Translate
  hub: StatusHub
}

export interface TitleProps {
  t: Translate
}

export interface GlyphProps {
  size?: number | undefined
  className?: string | undefined
}

interface StateFace {
  readonly dot: DotState
  readonly tone: TagTone
}

/**
 * The status mapping: a settled workspace is `done`, a load in flight is the
 * ongoing dot, a state that needs the operator but has not failed is amber, and
 * only a failure is red. Every host state the evaluator can report has a face
 * (see `src/types.ts`), so none of them can fall through to a grey default.
 */
const STATE_FACES: Record<string, StateFace> = {
  ok: { dot: 'done', tone: 'success' },
  loading: { dot: 'ongoing', tone: 'info' },
  idle: { dot: 'idle', tone: 'neutral' },
  absent: { dot: 'idle', tone: 'neutral' },
  disabled: { dot: 'idle', tone: 'quiet' },
  unreadable: { dot: 'warning', tone: 'warning' },
  blocked: { dot: 'warning', tone: 'warning' },
  'envrc-failed': { dot: 'warning', tone: 'warning' },
  'config-error': { dot: 'warning', tone: 'warning' },
  'direnv-unavailable': { dot: 'warning', tone: 'warning' },
  'route-down': { dot: 'error', tone: 'danger' },
  error: { dot: 'error', tone: 'danger' },
}

/** A state this build has never heard of is reported, never hidden. */
const UNKNOWN_FACE: StateFace = { dot: 'warning', tone: 'warning' }

/** The official bucket, worded by our own dictionary — the package ships no copy. */
const TIME_KEYS: Record<string, string> = {
  now: 'time.now',
  minutes: 'time.minutes',
  hours: 'time.hours',
  days: 'time.days',
  months: 'time.months',
  years: 'time.years',
}

function stateLabel(t: Translate, state: string): string {
  const key = `state.${state}`
  const label = t(key)
  return label === key ? t('state.unknown', { state: state }) : label
}

export function DirenvGlyph(props: GlyphProps): unknown {
  const size = props !== undefined && props !== null && typeof props.size === 'number' ? props.size : 16
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      className: props !== undefined && props !== null ? props.className : undefined,
    },
    h('rect', {
      key: 'frame',
      x: 2.25,
      y: 3.75,
      width: 19.5,
      height: 16.5,
      rx: 3.75,
      stroke: 'currentColor',
      strokeWidth: 1.5,
    }),
    h('path', {
      key: 'chevron',
      d: 'M7 9.75 10.25 12 7 14.25',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    h('path', {
      key: 'caret',
      d: 'M12.5 14.75h4.5',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
    }),
  )
}

/** One named fact: the official outline tag as the label, the value beside it. */
function Fact(props: { label: string; tone?: TagTone | undefined; wide?: boolean | undefined; children?: unknown }): unknown {
  const UI = ui()
  return h(
    'div',
    { style: L.row },
    h(UI.Tag, { key: 'label', tone: props.tone ?? 'outline', children: props.label }),
    h('div', { key: 'value', style: props.wide === true ? L.block : L.value }, props.children),
  )
}

function useStatus(hub: StatusHub, sessionId: string | undefined): StatusState | null {
  const [snapshot, setSnapshot] = useState<StatusState | null>(() =>
    hub !== undefined && hub !== null && sessionId ? hub.peek(sessionId) : null,
  )
  useEffect(() => {
    if (hub === undefined || hub === null || !sessionId) return undefined
    const handle = hub.watch(sessionId, {})
    setSnapshot(handle.snapshot())
    const unsubscribe = handle.subscribe(() => setSnapshot(handle.snapshot()))
    return () => {
      unsubscribe()
      handle.release()
    }
  }, [hub, sessionId])
  return snapshot
}

export function DirenvPanel(props: PanelProps): unknown {
  const UI = ui()
  const t = props.t
  const hub = props.hub
  const sessionId = props.sessionId
  const snapshot = useStatus(hub, sessionId)

  if (!sessionId) {
    return h('div', { style: L.root }, h('span', { style: L.text }, t('hint.noSession')))
  }

  const record = snapshot !== null && snapshot !== undefined ? snapshot.record : null
  const transportError = snapshot !== null && snapshot !== undefined ? snapshot.error : null
  const forcing = snapshot !== null && snapshot !== undefined && snapshot.forcing === true
  const answered = snapshot !== null && snapshot !== undefined && snapshot.at !== null

  const onReload = (): void => {
    if (hub === undefined || hub === null) return
    const handle = hub.watch(sessionId, {})
    Promise.resolve(handle.refresh(true))
      .then((outcome) => {
        if (outcome !== undefined && outcome !== null && outcome.ok !== true) {
          handle.notify('error', t('notify.reloadFailed', { detail: String(outcome.error ?? '') }))
        }
      })
      .catch(() => undefined)
      .then(() => handle.release())
  }

  const state = record !== null ? record.state : transportError !== null ? 'route-down' : answered ? 'idle' : 'loading'
  const face = STATE_FACES[state] ?? UNKNOWN_FACE
  const envrcPath = record !== null ? record.envrcPath : null
  const duration = record !== null ? formatMs(record.ms) : null
  const at = record !== null ? record.at : null
  const clock = at === null ? null : formatClock(at)
  const bucket = at === null || clock === null ? null : UI.relativeTime(at, Date.now())
  const age = bucket === null ? null : t(TIME_KEYS[bucket.unit] ?? 'time.now', { n: bucket.n })
  const dir = record !== null ? record.dir : ''
  const pollText = `${t('hint.poll', { seconds: Math.round(POLL_MS / 100) / 10 })}${dir !== '' ? ` · ${dir}` : ''}`

  const onReveal = (anyOpen: boolean): void => {
    if (hub === undefined || hub === null) return
    hub.wantsValues(sessionId, anyOpen === true)
  }

  const children: unknown[] = [
    h(
      'div',
      { key: 'status', style: L.group },
      h(
        'div',
        { key: 'state', style: L.chips },
        h(UI.StateDot, { key: 'dot', state: face.dot }),
        h(UI.Tag, { key: 'label', tone: face.tone, children: stateLabel(t, state) }),
      ),
      envrcPath !== null
        ? h(Fact, { key: 'envrc', label: t('label.envrcPath'), children: h(UI.PathLabel, { path: envrcPath }) })
        : h(Fact, { key: 'envrc', label: t('label.envrcPath'), children: t('hint.valueUnset') }),
      dir !== '' ? h(Fact, { key: 'dir', label: t('label.dir'), children: h(UI.PathLabel, { path: dir }) }) : null,
      duration !== null ? h(Fact, { key: 'ms', label: t('label.duration'), children: duration }) : null,
      clock !== null && age !== null
        ? h(Fact, {
            key: 'at',
            label: t('label.updated'),
            children: h(UI.Tooltip, {
              label: clock,
              portal: true,
              children: h('span', { style: L.text }, age),
            }),
          })
        : null,
      h(Fact, {
        key: 'memo',
        label: t('label.memoHit'),
        children: h(UI.Tag, {
          tone: record !== null && record.memoHit ? 'success' : 'neutral',
          children: record !== null && record.memoHit ? t('label.memoHitYes') : t('label.memoHitNo'),
        }),
      }),
      answered && record === null && transportError === null
        ? h('span', { key: 'no-workspace', style: L.text }, t('hint.noWorkspace'))
        : null,
      record !== null && record.errorSummary !== null
        ? h(Fact, {
            key: 'error',
            label: t('label.error'),
            tone: 'danger',
            wide: true,
            children: h('div', { style: L.capped }, record.errorSummary),
          })
        : null,
      record !== null && record.warnings.length > 0
        ? h(Fact, {
            key: 'warnings',
            label: t('label.warnings'),
            tone: 'warning',
            wide: true,
            children: h(
              'div',
              { style: L.group },
              record.warnings.map((warning) => h('span', { key: warning, style: L.block }, warning)),
            ),
          })
        : null,
      h(
        'div',
        { key: 'actions', style: L.chips },
        h(UI.Button, {
          key: 'reload',
          variant: 'outline',
          size: 'sm',
          icon: h(UI.IconRefreshOutlineRegular, { size: 14 }),
          disabled: forcing,
          onClick: onReload,
          children: forcing ? t('action.reloading') : t('action.reload'),
        }),
      ),
    ),
  ]

  if (record !== null && record.variables.length > 0) {
    children.push(h(EnvDetails, { key: 'env', t: t, record: record, onReveal: onReveal }))
  }
  const pathRemoved = record !== null && pathWasRemoved(record.variables, record.pathEntries)
  if (record !== null && (record.pathEntries.length > 0 || pathRemoved)) {
    children.push(h(PathEntries, { key: 'path', t: t, entries: record.pathEntries, unset: pathRemoved }))
  }
  if (record !== null && record.credentials.length > 0) {
    children.push(h(Credentials, { key: 'creds', t: t, names: record.credentials }))
  }

  children.push(
    h(
      'div',
      { key: 'footer', style: L.group },
      transportError !== null
        ? h(
            'div',
            { key: 'route', style: L.row },
            h(UI.Tag, { key: 'down', tone: 'danger', children: t('hint.routeDown') }),
            h('span', { key: 'detail', style: L.value }, firstLine(transportError, 80)),
          )
        : null,
      h('span', { key: 'poll', style: L.text }, pollText),
    ),
  )

  return h('div', { style: L.root }, children)
}

export function DirenvTabTitle(props: TitleProps): unknown {
  const t = props.t
  return h(fragment(), null, h(DirenvGlyph, { key: 'glyph', size: 16 }), h('span', { key: 'text' }, t('tab')))
}
