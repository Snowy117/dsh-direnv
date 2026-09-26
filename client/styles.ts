/**
 * The panel's visual vocabulary: one style object and the stylesheet that gives
 * it hover, focus and scrollbar behavior. Every color comes from a
 * `--dsw-alias-*` token, so the panel follows the harness theme in either mode.
 */

import { PLUGIN_ID } from './constants.ts'
import { report } from './ctx.ts'

export type ToneName = 'success' | 'warn' | 'error' | 'idle'

const TONES: Record<string, Record<string, string>> = {
  success: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
  },
  warn: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary))',
  },
  error: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)',
    color: 'var(--dsw-alias-state-error-primary)',
  },
  idle: {
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-tertiary)',
  },
}

export const S = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px 12px 20px',
    minWidth: 0,
    maxWidth: '100%',
    overflowX: 'hidden',
    boxSizing: 'border-box',
    fontSize: '12px',
    lineHeight: 1.55,
    color: 'var(--dsw-alias-label-primary)',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    minWidth: 0,
    padding: '10px',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  sectionTitle: {
    margin: '0 0 2px',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  row: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 },
  label: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
  value: {
    minWidth: 0,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    color: 'var(--dsw-alias-label-primary)',
  },
  mono: {
    minWidth: 0,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11.5px',
  },
  muted: { color: 'var(--dsw-alias-label-tertiary)' },
  caption: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
  pillBase: {
    flex: '0 0 auto',
    padding: '1px 8px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  tones: TONES,
  button: {
    appearance: 'none',
    font: 'inherit',
    fontSize: '12px',
    cursor: 'pointer',
    padding: '4px 10px',
    borderRadius: '8px',
    border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
  },
  buttonDisabled: {
    cursor: 'default',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '2px' },
  warnBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    minWidth: 0,
    padding: '8px 10px',
    borderRadius: '10px',
    background: 'var(--dsw-alias-state-warn-tertiary)',
    color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary))',
    border:
      '0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)) 24%, transparent)',
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0 },
  chip: {
    padding: '0 6px',
    borderRadius: '6px',
    background: 'var(--dsw-alias-markdown-inline-code)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11px',
    overflowWrap: 'anywhere',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    font: 'inherit',
    fontSize: '12px',
    padding: '4px 8px',
    borderRadius: '8px',
    border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-primary)',
  },
  varRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    minWidth: 0,
    padding: '2px 4px',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  varName: {
    flex: '0 0 auto',
    maxWidth: '52%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11.5px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  varValue: {
    minWidth: 0,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11.5px',
    color: 'var(--dsw-alias-label-primary)',
  },
  /**
   * Single-line fields only. `minWidth: 0` is what lets a flex child shrink
   * below its content width, which is the precondition for the ellipsis; a list
   * row must never take this style, because a wrapped path has to stay whole.
   */
  truncate: {
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The three `PATH` states. Added/removed reuse the theme's state tokens. */
  pathAdded: { color: 'var(--dsw-alias-state-success-primary)' },
  pathRemoved: { color: 'var(--dsw-alias-state-error-primary)', textDecoration: 'line-through' },
  pathUnchanged: { color: 'var(--dsw-alias-label-primary)' },
  pre: {
    margin: 0,
    maxHeight: '140px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-error)',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  spacer: { marginTop: 'auto' },
}

/** Injected once per document: hover, focus and scrollbar behavior for the panel. */
export function installStyles(): void {
  if (typeof document === 'undefined' || document === null) return
  try {
    const marker = `${PLUGIN_ID}/panel.css`
    if (typeof document.querySelector === 'function') {
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(marker)}]`)
      if (existing !== null && existing !== undefined) return
    }
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = marker
    tag.textContent = [
      '.dsh-direnv-root *{box-sizing:border-box}',
      '.dsh-direnv-root ::-webkit-scrollbar{width:6px;height:6px}',
      '.dsh-direnv-row:hover,.dsh-direnv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-direnv-name:hover{color:var(--dsw-alias-link);text-decoration:underline}',
      '.dsh-direnv-btn:focus-visible,.dsh-direnv-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-direnv-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-direnv-scroll{scrollbar-width:thin}',
    ].join('')
    document.head.appendChild(tag)
  } catch (error) {
    report(error)
  }
}
