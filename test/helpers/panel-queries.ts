/**
 * Lookups shared by the panel tests.
 *
 * The panel renders official disclosure rows for both its sections and its
 * variables, so a title alone cannot tell a section header from a row — a record
 * with a variable really named `PATH` puts a `PATH` row beside the `PATH`
 * section. A section is therefore found by the official glyph the panel gives
 * that section, and a disclosed value by the code-font token its span carries.
 */

import type { ElementInstance } from './fake-react.ts'
import type { Harness } from './client-harness.ts'
import { isRecord } from './guards.ts'

/** The official glyph that marks each section header, keyed by section. */
export const SECTION_ICONS = {
  variables: 'IconFlatListOutlineRegular',
  path: 'IconFolderOpenOutlineRegular',
  credentials: 'IconShieldOutlineRegular',
} as const

/** The glyph a variable row carries, which no section header does. */
export const ROW_ICON = 'IconSlidersTwoOutlineRegular'

/** The theme token the shell prints code with; the panel names it for environment values. */
export const CODE_FONT = 'var(--dsw-font-markdown-code-block)'

/** One official component element as a readable record, or `null` for anything else. */
export function elementOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

/** The inline style of one rendered node, or `null` when it carries none. */
export function styleOf(instance: ElementInstance): Record<string, unknown> | null {
  return elementOf(elementOf(instance.props)?.style)
}

/** The section header that carries one official icon, or `undefined` when it was not rendered. */
export function sectionOf(harness: Harness, panel: number, icon: string): ElementInstance | undefined {
  return harness.primitives(panel, 'DisclosureRow').find((instance) => {
    const element = elementOf(instance.props.icon)
    return element !== null && harness.primitiveName(element.type) === icon
  })
}

/** The variable row with this exact title, which is never a section header. */
export function variableRow(harness: Harness, panel: number, name: string): ElementInstance | undefined {
  return harness.primitives(panel, 'DisclosureRow').find((instance) => {
    const element = elementOf(instance.props.icon)
    return instance.props.title === name && element !== null && harness.primitiveName(element.type) === ROW_ICON
  })
}

/** The host span the panel gives a disclosed value, or `null` while no value is on screen. */
export function valueSpan(harness: Harness, panel: number): ElementInstance | null {
  const found = harness.react.findAll(panel, (instance) => {
    if (instance.kind !== 'host' || instance.type !== 'span') return false
    const style = elementOf(instance.props.style)
    return style !== null && style.font === CODE_FONT
  })[0]
  return found !== undefined && found.kind !== 'text' ? found : null
}
