import { BrowserWindow } from 'electron'

/**
 * Frame-disposal-safe IPC delivery to renderer windows.
 *
 * `window.isDestroyed()` only reports whether the *window object* is gone — it
 * stays `false` when the window is alive but its render frame was disposed by a
 * reload, an in-window navigation, or a renderer crash. `webContents.send` then
 * throws `Render frame was disposed before WebFrameMain could be accessed`.
 * During a long streaming generation (Critical Thinking synthesis, an agent
 * run, terminal output) the broadcasters fire once per token, so a single dead
 * frame becomes thousands of unhandled throws that flood the log and can take
 * the run down with it. `webContents.isDestroyed()` closes the common case; the
 * try/catch absorbs the residual race where the frame is disposed between the
 * guard and the send. Delivering a UI update to a dead frame is best-effort by
 * nature, so a miss is silently dropped.
 *
 * Kept dependency-light on purpose (only `electron`) so every main-process
 * service can import it without dragging in window/menu construction.
 */
export function sendToWindow(window: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  try {
    window.webContents.send(channel, ...args)
  } catch {
    // Frame was disposed between the guard and the send — nothing to deliver.
  }
}

/** Broadcast an IPC message to every open renderer window, frame-disposal safe. */
export function broadcastToWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) sendToWindow(window, channel, ...args)
}
