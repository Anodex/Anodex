import { ipcMain } from 'electron'

/**
 * A record of every `ipcMain.handle` registration, so the remote bridge can
 * re-dispatch to the *same* handler functions the renderer uses.
 *
 * ## Why this exists at all
 *
 * The design rule is that the bridge never forks a handler (§3.2): a forked
 * handler is a second place every future feature has to be added, and it will
 * silently drift. But Electron gives no way to read back what `ipcMain.handle`
 * registered, so re-dispatch needs a record of its own.
 *
 * ## Why it patches rather than changing 178 call sites
 *
 * The alternative is a wrapper every handler file imports instead of `ipcMain`.
 * That is more honest to read and worse to maintain: 178 edits now, and one
 * forgotten import later is a channel the phone cannot reach, failing as a
 * confusing "unknown channel" rather than as a compile error. Patching once,
 * before any handler registers, cannot be partially applied — either every
 * registration is captured or none is, and the latter is loud.
 *
 * The patch is additive: the real `ipcMain.handle` still runs, so renderer
 * behaviour is untouched.
 */

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
let patched = false

/**
 * Begin recording handler registrations. Must run before `registerAllHandlers`.
 *
 * Idempotent, because a second patch would wrap the wrapper and record twice.
 */
export function captureIpcHandlers(): void {
  if (patched) return
  patched = true

  const original = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: IpcHandler) => {
    handlers.set(channel, listener)
    return original(channel, listener as Parameters<typeof original>[1])
  }) as typeof ipcMain.handle
}

/** The handler for a channel, or undefined if nothing registered one. */
export function handlerFor(channel: string): IpcHandler | undefined {
  return handlers.get(channel)
}

/** Every channel that has a handler. Used by diagnostics and by the bridge's tests. */
export function registeredChannels(): string[] {
  return [...handlers.keys()].sort()
}

/** Test seam: forget everything recorded. Does not unpatch. */
export function resetCapturedHandlersForTests(): void {
  handlers.clear()
}
