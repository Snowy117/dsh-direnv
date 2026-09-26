/**
 * Environment details: masked values, per-row reveal, name search, and name
 * copying. Row state is component-local, so a poll never collapses a row the
 * reader opened. Values arrive only while at least one row is open — the panel
 * asks the host for them on reveal and stops asking on collapse.
 */

import { isThenable } from './ctx.ts'
import { MASK, ellipsizeMiddle } from './format.ts'
import { h, useEffect, useState } from './react.ts'
import { S } from './styles.ts'
import type { ViewRecord, ViewVariable } from './status-view.ts'
import type { Translate } from './messages.ts'

/** The three DOM events these rows handle; no react types are available here. */
interface ValueChangeEvent {
  readonly target: { readonly value: string }
}
interface RowKeyEvent {
  readonly key: string
  preventDefault(): void
}
interface NameClickEvent {
  stopPropagation(): void
}

export interface EnvDetailsProps {
  t: Translate
  record: ViewRecord
  onReveal?: ((anyOpen: boolean) => void) | undefined
}

function valueText(t: Translate, record: ViewRecord, variable: ViewVariable, revealed: boolean): string {
  if (record.env === null) return variable.hasValue ? MASK : t('hint.valueUnset')
  const raw = Object.prototype.hasOwnProperty.call(record.env, variable.name) ? record.env[variable.name] : undefined
  if (raw === undefined || raw === null) return t('hint.valueRemoved')
  if (revealed) return String(raw)
  return MASK
}

export function EnvDetails(props: EnvDetailsProps): unknown {
  const t = props.t
  const record = props.record
  const [query, setQuery] = useState('')
  const [revealed, setRevealed] = useState<Record<string, boolean> | null>(null)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    if (copied === '') return undefined
    const timer = setTimeout(() => setCopied(''), 1400)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(
    () => () => {
      if (typeof props.onReveal === 'function') props.onReveal(false)
    },
    [],
  )

  const open = revealed ?? {}
  const announce = (next: Record<string, boolean>): void => {
    if (typeof props.onReveal === 'function') props.onReveal(Object.keys(next).some((name) => next[name] === true))
  }
  const toggle = (name: string): void => {
    const next = { ...open, [name]: open[name] !== true }
    setRevealed(next)
    announce(next)
  }
  const copy = (name: string): void => {
    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
      if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
        const pending = clipboard.writeText(name)
        if (isThenable(pending)) void Promise.resolve(pending).then(() => setCopied(name)).catch(() => undefined)
        else setCopied(name)
      }
    } catch {
      /* clipboard is a courtesy, never a requirement */
    }
  }

  const needle = query.trim().toLowerCase()
  const rows =
    needle === ''
      ? record.variables
      : record.variables.filter((variable) => variable.name.toLowerCase().indexOf(needle) !== -1)

  return h(
    'div',
    { style: S.card },
    h('div', { style: S.sectionTitle }, t('label.variables')),
    record.variables.length > 6
      ? h('input', {
          type: 'search',
          className: 'dsh-direnv-input',
          style: S.input,
          value: query,
          placeholder: t('label.search'),
          'aria-label': t('label.search'),
          onChange: (event: ValueChangeEvent) => setQuery(event.target.value),
        })
      : null,
    h(
      'div',
      { style: S.row },
      h('span', { style: S.caption }, t('label.count', { count: rows.length })),
      record.env === null ? h('span', { style: S.caption }, `· ${t('hint.noValues')}`) : null,
      copied === ''
        ? h('span', { style: S.caption }, `· ${t('hint.copyHint')}`)
        : h('span', { style: S.caption }, `· ${t('hint.copied')}`),
    ),
    rows.length === 0
      ? h('div', { style: S.muted }, t('hint.empty'))
      : h(
          'div',
          { className: 'dsh-direnv-scroll', style: { ...S.list, maxHeight: '320px', overflowY: 'auto' } },
          rows.map((variable) =>
            h(
              'div',
              {
                key: variable.name,
                className: 'dsh-direnv-row',
                style: S.varRow,
                role: 'button',
                tabIndex: 0,
                title: open[variable.name] === true ? t('action.hide') : t('action.reveal'),
                onClick: () => toggle(variable.name),
                onKeyDown: (event: RowKeyEvent) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggle(variable.name)
                  }
                },
              },
              h(
                'span',
                {
                  key: 'name',
                  className: 'dsh-direnv-name',
                  style: S.varName,
                  title: `${variable.name} — ${t('action.copyName')}`,
                  onClick: (event: NameClickEvent) => {
                    event.stopPropagation()
                    copy(variable.name)
                  },
                },
                variable.name,
              ),
              h('span', { key: 'value', style: S.varValue }, valueText(t, record, variable, open[variable.name] === true)),
            ),
          ),
        ),
    h('div', { style: S.caption }, t('hint.masked')),
  )
}

export interface PathAdditionsProps {
  t: Translate
  items: readonly string[]
}

export function PathAdditions(props: PathAdditionsProps): unknown {
  const t = props.t
  const items = props.items
  return h(
    'div',
    { style: S.card },
    h('div', { style: S.sectionTitle }, t('label.pathAdditions')),
    items.length === 0
      ? h('div', { style: S.muted }, t('hint.empty'))
      : h(
          'div',
          { style: S.list },
          items.map((item) => h('div', { key: item, style: { ...S.mono, ...S.value }, title: item }, ellipsizeMiddle(item, 44))),
        ),
  )
}

export interface CredentialsProps {
  t: Translate
  names: readonly string[]
}

export function Credentials(props: CredentialsProps): unknown {
  const t = props.t
  const names = props.names
  return h(
    'div',
    { style: S.warnBox },
    h('div', { style: { ...S.sectionTitle, color: 'inherit' } }, `${t('label.credentials')} · ${t('hint.credentials')}`),
    h(
      'div',
      { style: S.chips },
      names.map((name) => h('span', { key: name, style: S.chip }, name)),
    ),
  )
}
