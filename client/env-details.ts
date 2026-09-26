/**
 * Environment details: masked values, per-row reveal, name search, name copying,
 * and the `PATH` diff.
 *
 * Row state is component-local, so a poll never collapses a row the reader
 * opened. Values arrive only while at least one row is open — the panel asks the
 * host for them on reveal and stops asking on collapse.
 *
 * The reading order of the `PATH` card is the host's own: the diff arrives as an
 * ordered list of entries, each already marked added, removed or unchanged, so
 * the card renders that list as it stands and never re-diffs it. Every row is an
 * official tag (one tone per transition, plus an icon so the two changed states
 * stay apart without colour) around an official `PathLabel`, which renders the
 * whole component and keeps it on hover. A `PATH` row is therefore never
 * shortened in JavaScript.
 */

import { MASK } from './format.ts'
import type { Translate } from './messages.ts'
import type { IconProps, Primitives, TagTone } from './primitives.ts'
import { ui } from './primitives.ts'
import { h, useEffect, useState } from './react.ts'
import { L } from './styles.ts'
import type { PathChange, PathEntry } from '../src/types.ts'
import type { ViewRecord, ViewVariable } from './status-view.ts'

/** The DOM event the search field handles; no react types are available here. */
interface ValueChangeEvent {
  readonly target: { readonly value: string }
}

type IconPart = (props: IconProps) => unknown

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
  const UI = ui()
  const t = props.t
  const record = props.record
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<readonly string[]>([])
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

  const announce = (next: readonly string[]): void => {
    if (typeof props.onReveal === 'function') props.onReveal(next.length > 0)
  }
  const toggle = (name: string): void => {
    const next = open.includes(name) ? open.filter((item) => item !== name) : [...open, name]
    setOpen(next)
    announce(next)
  }
  const copy = (name: string): void => {
    try {
      Promise.resolve(UI.writeClipboard(name))
        .then((ok) => {
          if (ok === true) setCopied(name)
        })
        .catch(() => undefined)
    } catch {
      /* clipboard is a courtesy, never a requirement */
    }
  }

  const needle = query.trim().toLowerCase()
  const rows =
    needle === ''
      ? record.variables
      : record.variables.filter((variable) => variable.name.toLowerCase().indexOf(needle) !== -1)

  const row = (variable: ViewVariable): unknown => {
    const isOpen = open.includes(variable.name)
    return h(UI.DisclosureRow, {
      key: variable.name,
      icon: h(UI.IconSlidersTwoOutlineRegular, { size: 14 }),
      title: variable.name,
      open: isOpen,
      expandable: true,
      expandOnRowClick: true,
      keepContentWhenOpen: true,
      onToggle: () => toggle(variable.name),
      collapsedContent: h(UI.Tooltip, {
        label: isOpen ? t('action.hide') : t('action.reveal'),
        portal: true,
        children: h('span', { style: L.inline }, h(UI.Tag, { tone: 'quiet', children: valueText(t, record, variable, false) })),
      }),
      children: h(
        'div',
        { style: L.row },
        h('span', { key: 'value', style: L.value }, valueText(t, record, variable, true)),
        h(UI.Button, {
          key: 'copy',
          variant: 'toolbar',
          size: 'sm',
          icon: h(UI.IconCopyOutlineRegular, { size: 14 }),
          title: t('action.copyName'),
          onClick: () => copy(variable.name),
        }),
      ),
    })
  }

  return h(
    'div',
    { style: L.group },
    h(UI.Tag, { key: 'title', tone: 'outline', children: t('label.variables') }),
    record.variables.length > 6
      ? h(UI.Input, {
          key: 'search',
          type: 'search',
          value: query,
          placeholder: t('label.search'),
          'aria-label': t('label.search'),
          icon: h(UI.IconSearchOutlineRegular, { size: 14 }),
          onChange: (event: ValueChangeEvent) => setQuery(event.target.value),
        })
      : null,
    h(
      'div',
      { key: 'count', style: L.chips },
      h(UI.Pill, { key: 'count', children: t('label.count', { count: rows.length }) }),
      record.env === null ? h('span', { key: 'values', style: L.text }, t('hint.noValues')) : null,
      h('span', { key: 'copy', style: L.text }, copied === '' ? t('hint.copyHint') : t('hint.copied')),
    ),
    rows.length === 0
      ? h('span', { key: 'empty', style: L.text }, t('hint.empty'))
      : h('div', { key: 'rows', style: L.scroll }, rows.map(row)),
    h('span', { key: 'masked', style: L.text }, t('hint.masked')),
  )
}

export interface PathEntriesProps {
  t: Translate
  entries: readonly PathEntry[]
  unset: boolean
}

/**
 * One face per transition, decided by a switch over the closed union: a fourth
 * `PathChange` cannot silently render an unmarked row.
 */
function pathFace(UI: Primitives, change: PathChange): { tone: TagTone; icon: IconPart | null } {
  switch (change) {
    case 'added':
      return { tone: 'success', icon: UI.IconPlusOutlineRegular }
    case 'removed':
      return { tone: 'danger', icon: UI.IconCloseOutlineRegular }
    case 'unchanged':
      return { tone: 'neutral', icon: null }
  }
}

/** An unset `PATH` and an untouched one both diff to nothing; only the variable list tells them apart. */
export function pathWasRemoved(variables: readonly ViewVariable[], entries: readonly PathEntry[]): boolean {
  if (entries.length > 0) return false
  return variables.some((variable) => variable.name === 'PATH' && variable.hasValue === false)
}

export function PathEntries(props: PathEntriesProps): unknown {
  const UI = ui()
  const t = props.t
  const entries = props.entries
  const body =
    entries.length === 0
      ? h('span', { key: 'none', style: L.text }, props.unset ? t('hint.pathUnset') : t('hint.empty'))
      : h(
          'div',
          { key: 'list', style: L.group },
          entries.map((entry, index) => {
            const face = pathFace(UI, entry.change)
            const label =
              entry.value === '' ? t('hint.pathEmpty') : h(UI.PathLabel, { key: 'path', path: entry.value })
            return h(UI.Tag, {
              // The same component may repeat in a PATH, so position is part of the key.
              key: `${String(index)}\u0000${entry.value}`,
              tone: face.tone,
              children: face.icon === null ? label : [h(face.icon, { key: 'mark', size: 12 }), label],
            })
          }),
        )
  return h(
    'div',
    { style: L.group },
    h(UI.Tag, { key: 'title', tone: 'outline', children: t('label.path') }),
    props.unset ? null : h('span', { key: 'order', style: L.text }, t('hint.pathOrder')),
    body,
  )
}

export interface CredentialsProps {
  t: Translate
  names: readonly string[]
}

export function Credentials(props: CredentialsProps): unknown {
  const UI = ui()
  const t = props.t
  const names = props.names
  return h(
    'div',
    { style: L.group },
    h(UI.Tag, {
      key: 'title',
      tone: 'warning',
      children: `${t('label.credentials')} · ${t('hint.credentials')}`,
    }),
    h(
      'div',
      { key: 'names', style: L.chips },
      names.map((name) => h(UI.Tag, { key: name, tone: 'warning', children: name })),
    ),
  )
}
