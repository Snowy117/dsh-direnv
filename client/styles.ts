/**
 * The panel's layout vocabulary — and nothing else.
 *
 * Color, radius, border and shadow all belong to the official primitives the
 * panel composes (`client/primitives.ts`), so an installed theme restyles the
 * panel together with the rest of the shell. Nothing here may gain one of those
 * properties, and nothing here needs an injected stylesheet: a block that wants
 * a fill or an edge wants an official component instead. The shell publishes
 * color and font tokens but no spacing token, so the pixel gaps below are the
 * layout itself rather than a palette choice.
 *
 * Two type facts are named here, both as theme variables rather than values.
 * `font-size` is the shell's own content-size knob: the official components each
 * set their own size (`DisclosureRow`'s title is the secondary tier at 13px), and
 * text that names no size at all inherits the browser's 16px, which would leave
 * the panel's plain sentences *larger* than its section titles. The code token is
 * exactly what the official `CodeCard` / `TerminalBlock` put on their bodies: a
 * value the reader may have to copy has to be monospaced, and naming the theme
 * variable is how that happens without this plugin owning a typeface.
 *
 * `minWidth: 0` is what lets a flex child shrink below its content width, which
 * is the precondition for every path that has to fit a narrow sidebar.
 */

/**
 * The x an official `DisclosureRow` title starts at: its leading box is
 * `calc(16px + var(--dsh-content-font-delta, 0px))` wide with a 6px gap after it
 * (`DisclosureRow.module.css`), and the delta is the shell's own content-font-size
 * axis. Indenting by the same expression keeps a disclosed body under the title
 * it belongs to at every font size the reader picks.
 */
const TITLE_INDENT = 'calc(22px + var(--dsh-content-font-delta, 0px))'

export const L = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    fontSize: 'var(--dsh-content-font-size, 14px)',
    gap: '10px',
    padding: '12px 12px 20px',
    minWidth: 0,
    maxWidth: '100%',
    boxSizing: 'border-box',
  },
  group: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
  row: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 },
  chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', minWidth: 0 },
  value: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  block: {
    flex: '1 1 auto',
    minWidth: 0,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  text: { minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
    paddingLeft: TITLE_INDENT,
    boxSizing: 'border-box',
  },
  valueRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    minWidth: 0,
    paddingLeft: TITLE_INDENT,
    boxSizing: 'border-box',
  },
  /**
   * The environment value as the shell prints code. `white-space: pre-wrap` only
   * decides where a long line may break: a newline, a tab and a run of spaces are
   * the value's own bytes and reach the reader unchanged.
   */
  code: {
    flex: '1 1 auto',
    minWidth: 0,
    font: 'var(--dsw-font-markdown-code-block)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  /** Both windows exist so a long environment or a long host message cannot push the panel's own rows off screen. */
  scroll: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, maxHeight: '320px', overflowY: 'auto' },
  capped: {
    maxHeight: '140px',
    overflowY: 'auto',
    minWidth: 0,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
} as const
