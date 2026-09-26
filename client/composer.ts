/**
 * The composer's two seats: the block this plugin may raise, and the failure
 * toast. Both belong to the conversation service rather than to the panel, so
 * they live here with the ownership rules that keep them from stepping on
 * another plugin's work.
 *
 * The composer block registry is shared — `ui-model-selection` blocks the same
 * composer when no model can route a prompt — so a block is only written into an
 * empty seat or over this plugin's own text, and only ever cleared when this
 * plugin still owns it.
 */

import type { ClientContext } from './ctx.ts'
import { asObject, debugLog, report, safeService } from './ctx.ts'
import { useEffect } from './react.ts'
import type { NotifyFn, StatusHub } from './hub.ts'

export interface ComposerBlocks {
  set?: ((sessionId: string, block: { reason: string } | undefined) => unknown) | undefined
  storeFor?: ((sessionId: string) => BlockStore | null | undefined) | undefined
}

interface BlockStore {
  getSnapshot?: (() => BlockSnapshot | null | undefined) | undefined
}

interface BlockSnapshot {
  reason?: unknown
}

export interface BlockGuard {
  setBlock(sessionId: string, reason: string): void
  clearBlock(sessionId: string): void
}

/** The registry as this plugin reads it; every member is probed before it is called. */
function composerBlocksOf(ctx: ClientContext): ComposerBlocks | null {
  const conversation = asObject(safeService(ctx, 'conversation'))
  const blocks = conversation === null ? null : asObject(conversation.blocks)
  return blocks === null ? null : (blocks as ComposerBlocks)
}

/**
 * Create the ownership guard for one applied plugin.
 *
 * `ownedBlocks` remembers the text this plugin wrote per session, so a later
 * `clearBlock` can tell "ours" from "someone else's"; `skippedBlocks` remembers
 * the foreign reason already reported, so the skip is logged once instead of on
 * every poll.
 */
export function createBlockGuard(ctx: ClientContext): BlockGuard {
  const ownedBlocks = new Map<string, string>()
  const skippedBlocks = new Map<string, unknown>()

  function currentBlockReason(blocks: ComposerBlocks, sessionId: string): { known: boolean; reason: unknown } {
    const storeFor = blocks.storeFor
    if (typeof storeFor !== 'function') return { known: false, reason: undefined }
    try {
      const store = storeFor(sessionId)
      const snapshot =
        store === undefined || store === null || typeof store.getSnapshot !== 'function'
          ? undefined
          : store.getSnapshot()
      return { known: true, reason: snapshot === undefined || snapshot === null ? undefined : snapshot.reason }
    } catch {
      return { known: false, reason: undefined }
    }
  }

  function setBlock(sessionId: string, reason: string): void {
    const blocks = composerBlocksOf(ctx)
    const set = blocks === null ? undefined : blocks.set
    if (blocks === null || typeof set !== 'function') return
    const current = currentBlockReason(blocks, sessionId)
    const ours = current.reason !== undefined && current.reason === reason
    const free = current.known === true && current.reason === undefined
    if (!ours && !free && ownedBlocks.get(sessionId) !== reason) {
      if (skippedBlocks.get(sessionId) !== current.reason) {
        skippedBlocks.set(sessionId, current.reason)
        debugLog('composer is blocked by another plugin; leaving its block alone:', current.reason)
      }
      return
    }
    skippedBlocks.delete(sessionId)
    try {
      set(sessionId, { reason: reason })
      ownedBlocks.set(sessionId, reason)
    } catch (error) {
      report(error)
    }
  }

  /**
   * Clear only a block this plugin still owns: an unconditional
   * `set(sessionId, undefined)` would unlock someone else's composer.
   */
  function clearBlock(sessionId: string): void {
    const owned = ownedBlocks.get(sessionId)
    if (owned === undefined) return
    const blocks = composerBlocksOf(ctx)
    const set = blocks === null ? undefined : blocks.set
    if (blocks === null || typeof set !== 'function') return
    try {
      const current = currentBlockReason(blocks, sessionId)
      if (current.known === true && current.reason !== owned) {
        ownedBlocks.delete(sessionId)
        return
      }
      set(sessionId, undefined)
      ownedBlocks.delete(sessionId)
    } catch (error) {
      report(error)
    }
  }

  return { setBlock: setBlock, clearBlock: clearBlock }
}

interface InputShell {
  notify?: ((level: string, text: string) => unknown) | undefined
}

interface ConversationInput {
  for?: ((actx: unknown) => InputShell | null | undefined) | undefined
  shell?: ((sessionId: string | undefined) => InputShell | null | undefined) | undefined
}

/**
 * The failure toast seat: `conversation.input.for(actx).notify('error', text)`
 * over the session's own input shell, with the id-addressed service path as a
 * fallback. Both routes can legitimately refuse (an unrealized session, a
 * composer that is not mounted), and a refused notice is not an error.
 */
export function createNotifier(ctx: ClientContext, sessionId: string | undefined): NotifyFn {
  return function notify(level: string, text: string): boolean {
    try {
      const conversation = asObject(safeService(ctx, 'conversation'))
      const input = conversation === null ? null : asObject(conversation.input)
      if (input === null) return false
      const face = input as ConversationInput
      let shell: InputShell | null | undefined
      const openFor = face.for
      if (typeof openFor === 'function') {
        const sessions = asObject(safeService(ctx, 'sessions'))
        const scope = sessions === null ? undefined : sessions.scope
        const actx =
          sessions !== null && typeof scope === 'function'
            ? (scope as (id: string | undefined) => unknown)(sessionId)
            : undefined
        if (actx !== undefined && actx !== null) shell = openFor(actx)
      }
      const openShell = face.shell
      if (shell === undefined && typeof openShell === 'function') shell = openShell(sessionId)
      if (shell === undefined || shell === null) return false
      const deliver = shell.notify
      if (typeof deliver !== 'function') return false
      deliver(level, text)
      return true
    } catch {
      return false
    }
  }
}

export interface DockProps {
  sessionId: string | undefined
  hub: StatusHub
  notify: NotifyFn
}

/**
 * An invisible per-session entry in the composer dock.
 *
 * It renders nothing; its whole job is to exist for every mounted composer so
 * the hub can (a) block that session's input while direnv is confirmed to be
 * loading and (b) raise the failure toast through that session's own input
 * shell. A `display: contents` slot anchor makes the empty cell free.
 */
export function DirenvSessionHook(props: DockProps): unknown {
  const hub = props.hub
  const sessionId = props.sessionId
  const notify = props.notify
  useEffect(() => {
    if (hub === undefined || hub === null || !sessionId) return undefined
    const handle = hub.watch(sessionId, { notify: notify })
    return () => handle.release()
  }, [hub, sessionId, notify])
  return null
}
