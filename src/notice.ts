/**
 * Renders what the model is told about the session's direnv environment, and
 * decides when it is worth telling again.
 *
 * Two rules bound the wording: the `.envrc` body and variable values never
 * appear (a `.envrc` is arbitrary code and its overlay is where credentials
 * live), and credential names stay out of model-facing text — the sidebar shows
 * those to the operator instead. A session therefore pays for one short message
 * per state change, and nothing at all when a directory has no `.envrc`.
 */

import type { PathEntry, StatusRecord } from './types.ts'

const MAX_NAME_SAMPLE = 6

export interface NoticeMessage {
  text: string
  digest: string
}

export interface NoticeTracker {
  /**
   * Answers with the message to inject, or `null` when this session already
   * knows this state (or has no conclusion to report yet).
   */
  observe(sessionId: string, status: StatusRecord): NoticeMessage | null
  forget(sessionId: string): void
  size(): number
}

interface NoticeState {
  digest: string
  names: Set<string>
  state: StatusRecord['state']
  ms: number | null
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`
}

function summarizeNames(names: readonly string[]): string {
  const sample = names.slice(0, MAX_NAME_SAMPLE)
  const rest = names.length - sample.length
  return rest > 0 ? `${sample.join(', ')} (+${String(rest)} more)` : sample.join(', ')
}

/**
 * Both counts stay in the message and neither path component does: `PATH`
 * entries are machine-specific absolute paths, and the model only needs to know
 * that the workspace's search path differs from the harness default.
 */
function pathCounts(entries: readonly PathEntry[]): string {
  let added = 0
  let removed = 0
  for (const entry of entries) {
    if (entry.change === 'added') added += 1
    else if (entry.change === 'removed') removed += 1
  }
  if (removed === 0) return added === 0 ? '' : `${plural(added, 'PATH entry', 'PATH entries')} added`
  const removedText = `${String(removed)} removed`
  return added === 0 ? `${plural(removed, 'PATH entry', 'PATH entries')} removed` : `${plural(added, 'PATH entry', 'PATH entries')} added, ${removedText}`
}

function baselineText(status: StatusRecord): string {
  const where = status.envrcPath ?? status.dir
  switch (status.state) {
    case 'ok': {
      const parts = [plural(status.variables.length, 'variable')]
      const paths = pathCounts(status.pathEntries)
      if (paths !== '') parts.push(paths)
      if (status.credentials.length > 0) parts.push(`${String(status.credentials.length)} credential-like, values available to commands`)
      parts.push(`${String(status.ms ?? 0)} ms`)
      return `direnv loaded ${where} for this workspace: ${parts.join(', ')}. Every command you run here inherits it.`
    }
    case 'absent':
      return `No .envrc applies to ${status.dir}; commands run with the harness environment unchanged.`
    case 'blocked':
      return `direnv is blocked for ${where}: the file is not approved yet. Commands run with the harness environment unchanged. The user must run \`direnv allow\` in a real terminal — do not attempt to approve it yourself.`
    case 'unreadable':
      return `direnv cannot read ${where} (permission denied); commands run with the harness environment unchanged.`
    case 'envrc-failed':
      return `direnv failed while evaluating ${where} (${status.errorSummary ?? 'unknown exit status'}); commands run with the harness environment unchanged.`
    case 'config-error':
      return `direnv could not parse the user's direnv configuration; commands run with the harness environment unchanged.`
    case 'direnv-unavailable':
      return `direnv is not installed, so no workspace environment is applied.`
    case 'disabled':
      return `direnv is disabled for this workspace by configuration; commands run with the harness environment unchanged.`
    case 'error':
      return `direnv did not finish for ${status.dir} (${status.errorSummary ?? 'unknown error'}). Commands run with the harness environment unchanged, and this workspace is evaluated again on the next command.`
    default:
      return `direnv reported an error for ${status.dir} (${status.errorSummary ?? 'unknown'}); commands run with the harness environment unchanged.`
  }
}

function changedText(previous: NoticeState, status: StatusRecord): string | null {
  if (previous.state !== 'ok' || status.state !== 'ok') return baselineText(status)
  const before = previous.names
  const after = new Set(status.variables.map((variable) => variable.name))
  const added = [...after].filter((name) => !before.has(name))
  const removed = [...before].filter((name) => !after.has(name))
  if (added.length === 0 && removed.length === 0 && previous.ms === status.ms) return null
  const changes: string[] = []
  if (added.length > 0) changes.push(`added ${summarizeNames(added)}`)
  if (removed.length > 0) changes.push(`removed ${summarizeNames(removed)}`)
  const detail = changes.length === 0 ? 're-evaluated' : changes.join(', ')
  const paths = pathCounts(status.pathEntries)
  const pathLine = paths === '' ? '' : ` PATH: ${paths}.`
  return `direnv re-evaluated ${status.envrcPath ?? status.dir}: ${detail}.${pathLine}`
}

export function createNoticeTracker(): NoticeTracker {
  const sessions = new Map<string, NoticeState>()

  return {
    observe(sessionId: string, status: StatusRecord): NoticeMessage | null {
      // A re-evaluation in flight (`loading`) and a directory nobody has looked at
      // (`idle`) are not conclusions: reporting them would tell the model about an
      // error that does not exist. Skipping without touching the stored state also
      // keeps an ok → loading → ok round trip from re-announcing an unchanged
      // workspace.
      if (status.state === 'loading' || status.state === 'idle') return null
      const previous = sessions.get(sessionId)
      const names = new Set(status.variables.map((variable) => variable.name))
      const digest = `${status.state}|${status.envrcPath ?? ''}|${[...names].sort().join(',')}|${String(status.ms ?? '')}`
      if (previous !== undefined && previous.digest === digest) return null
      const text = previous === undefined ? baselineText(status) : changedText(previous, status)
      sessions.set(sessionId, { digest, names, state: status.state, ms: status.ms })
      if (text === null) return null
      return { text: `[dsh-direnv] ${text}`, digest }
    },
    forget(sessionId: string): void {
      sessions.delete(sessionId)
    },
    size(): number {
      return sessions.size
    },
  }
}
