/**
 * The panel's layout vocabulary — and nothing else.
 *
 * Color, radius, border, shadow and font all belong to the official primitives
 * the panel composes (`client/primitives.ts`), so an installed theme restyles the
 * panel together with the rest of the shell. Nothing here may gain one of those
 * properties, and nothing here needs an injected stylesheet: a block that wants
 * a fill, an edge or a typeface wants an official component instead. The shell
 * publishes color and font tokens but no spacing token, so the pixel gaps below
 * are the layout itself rather than a palette choice.
 *
 * `minWidth: 0` is what lets a flex child shrink below its content width, which
 * is the precondition for every path that has to fit a narrow sidebar.
 */

export const L = {
  root: {
    display: 'flex',
    flexDirection: 'column',
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
  inline: { minWidth: 0 },
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
