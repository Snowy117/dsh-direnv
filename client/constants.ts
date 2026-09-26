/**
 * The browser half's fixed vocabulary.
 *
 * Three of these are load-bearing in ways a reader cannot see (DESIGN.md §7.1):
 * `PLUGIN_ID` is at once the plugin's name, the locale table's id and the keyed
 * sidebar seat's key; `TAB_KIND` is only the tab's kind, and keying a seat by a
 * `kind` silently renders nothing; `STATUS_PATH` is the one route this half
 * reads and never writes.
 */

export const PLUGIN_ID = 'dsh-direnv'
export const TAB_KIND = 'direnv'
export const STATUS_PATH = '/plugins/dsh-direnv/status.json'

/** The poll cadence the panel footer advertises. */
export const POLL_MS = 1800
/** Three missed polls: past this, the last good answer is no longer trusted. */
export const STALE_MS = POLL_MS * 3

/** The frozen credential-matching rule (CONTRACTS.md, DESIGN.md D8). */
export const SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i
