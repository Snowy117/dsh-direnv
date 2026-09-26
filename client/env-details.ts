/**
 * Environment details: the variable list, the `PATH` diff and the credential
 * roster.
 *
 * Every section is one official `DisclosureRow`, which is also the panel's only
 * header typography: the disclosed body carries `L.sectionBody`, the official
 * leading geometry, so nothing a section shows can sit left of the title it
 * belongs to. Section and row state are component-local, so a poll never
 * collapses what the reader opened.
 *
 * Values arrive only while at least one row is open — the panel asks the host
 * for them on reveal and stops asking on collapse — so an open row can render an
 * empty value for one poll. There is no mask and no placeholder: a value is
 * shown as the bytes the host sent, or the row says it has none.
 *
 * The reading order of the `PATH` card is the host's own: the diff arrives as an
 * ordered list of entries, each already marked added, removed or unchanged, so
 * the card renders that list as it stands and never re-diffs it. Every row is an
 * official tag (one tone per transition, plus an icon so the two changed states
 * stay apart without colour) around an official `PathLabel`, which renders the
 * whole component and keeps it on hover. A `PATH` row is therefore never
 * shortened in JavaScript.
 */

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

interface SectionProps {
  icon: IconPart
  title: string
  open: boolean
  onToggle: () => void
  children?: unknown
}

/** One collapsible section: the official row as the header, its body indented under the title. */
function Section(props: SectionProps): unknown {
  const UI = ui()
  return h(UI.DisclosureRow, {
    icon: h(props.icon, { size: 14 }),
    title: props.title,
    open: props.open,
    expandable: true,
    expandOnRowClick: true,
    onToggle: props.onToggle,
    children: h('div', { style: L.sectionBody }, props.children),
  })
}

/** The section headers start open; the credential roster is the reader's to open. */
function useSection(initial: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(initial)
  return [open, () => setOpen(!open)]
}

/**
 * The value the host sent for one name, or `undefined` when the poll carried no
 * value map (values are fetched only while a row is open) or the name is gone
 * from it. `undefined` is never rendered as text and never reaches the clipboard.
 */
function valueOf(record: ViewRecord, name: string): string | undefined {
  if (record.env === null) return undefined
  if (!Object.prototype.hasOwnProperty.call(record.env, name)) return undefined
  const raw = record.env[name]
  return raw === undefined || raw === null ? undefined : String(raw)
}

export function EnvDetails(props: EnvDetailsProps): unknown {
  const UI = ui()
  const t = props.t
  const record = props.record
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<readonly string[]>([])
  const [copied, setCopied] = useState('')
  const [shown, toggleShown] = useSection(true)

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
  const copy = (name: string, value: string): void => {
    try {
      Promise.resolve(UI.writeClipboard(value))
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
    const value = valueOf(record, variable.name)
    const copyable = value !== undefined
    // The control carries no text, so its title is also its accessible name.
    const label = copied === variable.name ? t('hint.copied') : t('action.copyValue')
    return h(UI.DisclosureRow, {
      key: variable.name,
      icon: h(UI.IconSlidersTwoOutlineRegular, { size: 14 }),
      title: variable.name,
      open: isOpen,
      expandable: true,
      expandOnRowClick: true,
      onToggle: () => toggle(variable.name),
      children: h(
        'div',
        { style: L.valueRow },
        h(
          'span',
          { key: 'value', style: L.code },
          copyable ? value : record.env === null ? t('hint.valuePending') : t('hint.valueRemoved'),
        ),
        copyable
          ? h(UI.Button, {
              key: 'copy',
              variant: 'toolbar',
              size: 'sm',
              icon: h(copied === variable.name ? UI.IconCheckOutlineRegular : UI.IconCopyOutlineRegular, { size: 14 }),
              title: label,
              'aria-label': label,
              onClick: () => copy(variable.name, value),
            })
          : null,
      ),
    })
  }

  return h(
    'div',
    { style: L.group },
    h(Section, {
      key: 'section',
      icon: UI.IconFlatListOutlineRegular,
      title: t('label.variables'),
      open: shown,
      onToggle: toggleShown,
      children: [
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
        h('div', { key: 'count', style: L.chips }, h(UI.Pill, { children: t('label.count', { count: rows.length }) })),
        h('div', { key: 'rows', style: L.scroll }, rows.map(row)),
      ],
    }),
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
  const [open, toggleOpen] = useSection(true)
  const list = entries.map((entry, index) => {
    const face = pathFace(UI, entry.change)
    const label = entry.value === '' ? t('hint.pathEmpty') : h(UI.PathLabel, { key: 'path', path: entry.value })
    return h(UI.Tag, {
      // The same component may repeat in a PATH, so position is part of the key.
      key: `${String(index)}\u0000${entry.value}`,
      tone: face.tone,
      children: face.icon === null ? label : [h(face.icon, { key: 'mark', size: 12 }), label],
    })
  })
  return h(Section, {
    icon: UI.IconFolderOpenOutlineRegular,
    title: t('label.path'),
    open: open,
    onToggle: toggleOpen,
    children:
      entries.length === 0
        ? props.unset
          ? h('span', { style: L.text }, t('hint.pathUnset'))
          : null
        : h('div', { style: L.group }, list),
  })
}

export interface CredentialsProps {
  t: Translate
  names: readonly string[]
}

export function Credentials(props: CredentialsProps): unknown {
  const UI = ui()
  const t = props.t
  const [open, toggleOpen] = useSection(false)
  return h(Section, {
    icon: UI.IconShieldOutlineRegular,
    title: t('label.credentials'),
    open: open,
    onToggle: toggleOpen,
    children: h(
      'div',
      { style: L.chips },
      props.names.map((name) => h(UI.Tag, { key: name, tone: 'warning', children: name })),
    ),
  })
}
