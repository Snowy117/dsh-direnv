/**
 * The "hide the panel" preference.
 *
 * Keys are per browser tab and per session, so hiding is a view preference
 * rather than a workspace policy: it pauses this browser's polling and never
 * touches any command's environment. A failed storage (private mode, disabled
 * cookies) degrades to "not hidden".
 */

import { DISABLED_PREFIX } from './constants.ts'

export function readHidden(sessionId: string): boolean {
  try {
    const storage = globalThis.localStorage
    if (storage === undefined || storage === null) return false
    return storage.getItem(DISABLED_PREFIX + String(sessionId)) === '1'
  } catch {
    return false
  }
}

export function writeHidden(sessionId: string, hidden: boolean): boolean {
  try {
    const storage = globalThis.localStorage
    if (storage === undefined || storage === null) return false
    const key = DISABLED_PREFIX + String(sessionId)
    if (hidden) storage.setItem(key, '1')
    else storage.removeItem(key)
    return true
  } catch {
    return false
  }
}
