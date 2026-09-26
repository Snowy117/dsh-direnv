/**
 * The right-column panel: the header with its state pill, the status card, the
 * environment sections, and the hide/show control. It renders whatever the last
 * poll answered and never blocks: a poll in flight leaves the previous answer on
 * screen, and a failed poll says so in the footer instead of emptying the panel.
 *
 * The keyed seats this component fills are registered in `index.ts`; the key
 * there is the tab type's `id`, because a `kind` key silently renders nothing.
 */

import { POLL_MS } from './constants.ts'
import { firstLine, formatClock, formatMs, ellipsizeMiddle } from './format.ts'
import { readHidden, writeHidden } from './hidden.ts'
import type { StatusHub, StatusState } from './hub.ts'
import type { Translate } from './messages.ts'
import { h, fragment, useEffect, useState } from './react.ts'
import { S } from './styles.ts'
import type { ToneName } from './styles.ts'
import { Credentials, EnvDetails, PathAdditions } from './env-details.ts'

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

const STATE_TONES: Record<string, ToneName> = {
  ok: 'success',
  loading: 'idle',
  idle: 'idle',
  absent: 'idle',
  disabled: 'idle',
  unreadable: 'warn',
  blocked: 'warn',
  'envrc-failed': 'warn',
  'config-error': 'warn',
  'direnv-unavailable': 'warn',
  'route-down': 'warn',
  error: 'error',
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

function Tone(props: { tone: ToneName; children?: unknown }): unknown {
  const style = S.tones[props.tone] ?? S.tones.idle
  return h('span', { style: { ...S.pillBase, ...style } }, props.children)
}

function Line(props: { label: unknown; mono?: boolean | undefined; title?: string | undefined; children?: unknown }): unknown {
  return h(
    'div',
    { style: S.row },
    h('span', { style: S.label }, props.label),
    h('span', { style: props.mono === true ? { ...S.value, ...S.mono } : S.value, title: props.title }, props.children),
  )
}

function Button(props: {
  disabled?: boolean | undefined
  title?: string | undefined
  onClick?: (() => void) | undefined
  children?: unknown
}): unknown {
  const style = { ...S.button, ...(props.disabled === true ? S.buttonDisabled : {}) }
  return h(
    'button',
    {
      type: 'button',
      className: 'dsh-direnv-btn',
      style: style,
      disabled: props.disabled === true,
      title: props.title,
      onClick: props.disabled === true ? undefined : props.onClick,
    },
    props.children,
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
  const t = props.t
  const hub = props.hub
  const sessionId = props.sessionId
  const snapshot = useStatus(hub, sessionId)
  const [hidden, setHidden] = useState(() => (sessionId ? readHidden(sessionId) : false))
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])

  if (!sessionId) {
    return h('div', { style: S.root }, h('div', { style: S.muted }, t('hint.noSession')))
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

  const onToggleHidden = (): void => {
    const next = !hidden
    writeHidden(sessionId, next)
    setHidden(next)
    if (hub !== undefined && hub !== null) {
      const handle = hub.watch(sessionId, {})
      handle.sync()
      handle.release()
    }
  }

  const state = record !== null ? record.state : transportError !== null ? 'route-down' : answered ? 'idle' : 'loading'
  const tone = STATE_TONES[state] ?? 'warn'
  const envrcPath = record !== null ? record.envrcPath : null
  const duration = record !== null ? formatMs(record.ms) : null
  const clock = record !== null ? formatClock(record.at) : null
  const dir = record !== null ? record.dir : ''

  const onReveal = (anyOpen: boolean): void => {
    if (hub === undefined || hub === null) return
    hub.wantsValues(sessionId, anyOpen === true)
  }

  const children: unknown[] = [
    h(
      'div',
      { key: 'head', style: S.row },
      h('span', { style: { ...S.value, fontWeight: 600 } }, t('tab')),
      h('span', { style: S.spacer }),
      h(Tone, { key: 'tone', tone: tone }, stateLabel(t, state)),
    ),
  ]

  if (hidden) {
    children.push(
      h(
        'div',
        { key: 'hidden', style: S.warnBox },
        h('div', null, t('hint.hidden')),
        h('div', { style: S.caption }, t('hint.paused')),
      ),
    )
  } else {
    children.push(
      h(
        'div',
        { key: 'status', style: S.card },
        envrcPath !== null
          ? h(Line, { key: 'envrc', label: t('label.envrcPath'), mono: true, title: envrcPath }, ellipsizeMiddle(envrcPath, 46))
          : h(Line, { key: 'envrc', label: t('label.envrcPath') }, t('hint.valueUnset')),
        dir !== ''
          ? h(Line, { key: 'dir', label: t('label.dir'), mono: true, title: dir }, ellipsizeMiddle(dir, 46))
          : null,
        duration !== null ? h(Line, { key: 'ms', label: t('label.duration') }, duration) : null,
        clock !== null ? h(Line, { key: 'at', label: t('label.updated') }, clock) : null,
        h(
          Line,
          { key: 'memo', label: t('label.memoHit') },
          record !== null && record.memoHit ? t('label.memoHitYes') : t('label.memoHitNo'),
        ),
        answered && record === null && transportError === null
          ? h('div', { key: 'no-workspace', style: S.caption }, t('hint.noWorkspace'))
          : null,
        record !== null && record.errorSummary !== null
          ? h(
              'div',
              { key: 'error', style: { ...S.card, padding: '6px 8px', background: 'transparent' } },
              h('div', { style: S.sectionTitle }, t('label.error')),
              h('pre', { className: 'dsh-direnv-pre', style: S.pre }, record.errorSummary),
            )
          : null,
        record !== null && record.warnings.length > 0
          ? h(
              'div',
              { key: 'warnings', style: S.list },
              h('div', { style: S.sectionTitle }, t('label.warnings')),
              record.warnings.map((warning) => h('div', { key: warning, style: S.caption }, warning)),
            )
          : null,
        h(
          'div',
          { key: 'actions', style: S.actions },
          h(
            Button,
            { key: 'reload', disabled: forcing, title: t('action.reload'), onClick: onReload },
            forcing ? t('action.reloading') : t('action.reload'),
          ),
          h(
            Button,
            {
              key: 'hide',
              title: t('action.disable'),
              onClick: () => {
                onToggleHidden()
                setCopied(false)
              },
            },
            t('action.disable'),
          ),
        ),
      ),
    )

    if (record !== null && record.variables.length > 0) {
      children.push(h(EnvDetails, { key: 'env', t: t, record: record, onReveal: onReveal }))
    }
    if (record !== null && record.pathAdditions.length > 0) {
      children.push(h(PathAdditions, { key: 'path', t: t, items: record.pathAdditions }))
    }
    if (record !== null && record.credentials.length > 0) {
      children.push(h(Credentials, { key: 'creds', t: t, names: record.credentials }))
    }

    children.push(
      h(
        'div',
        { key: 'footer', style: S.card },
        transportError !== null
          ? h('div', { style: S.muted }, `${t('hint.routeDown')} — ${firstLine(transportError, 80)}`)
          : null,
        h(
          'div',
          { style: S.caption },
          t('hint.poll', { seconds: Math.round(POLL_MS / 100) / 10 }),
          record !== null && record.dir !== '' ? ` · ${ellipsizeMiddle(record.dir, 36)}` : '',
        ),
        h(Button, { key: 'show', onClick: onToggleHidden, title: t('action.enable') }, t('action.enable')),
      ),
    )
  }

  return h('div', { className: 'dsh-direnv-root', style: S.root }, children)
}

export function DirenvTabTitle(props: TitleProps): unknown {
  const t = props.t
  return h(fragment(), null, h(DirenvGlyph, { key: 'glyph', size: 16 }), h('span', { key: 'text' }, t('tab')))
}
