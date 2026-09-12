import { BrowserWindow } from 'electron'
import type { ClientChannel } from './clients/ClientChannel'
import { activeRemoteClients, wantsLiveTokens } from './clients/clientRegistry'

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

/**
 * Broadcast an IPC message to every attached client, frame-disposal safe.
 *
 * "Every client" now includes a paired phone, not only renderer windows. Fanning
 * out here rather than at each call site means every existing broadcaster gets
 * remote delivery without changing — one file, and the phone stops being a
 * second place every future feature has to be remembered in.
 *
 * The name is kept for its callers' sake; it is a window-plus-remote broadcast.
 * Remote clients take a single payload rather than Electron's variadic `args`,
 * because a wire frame carries one payload — every caller in this codebase
 * passes exactly one, and the rest are dropped rather than silently mangled.
 */
export function broadcastToWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) sendToWindow(window, channel, ...args)
  for (const client of activeRemoteClients()) client.send(channel, args[0])
}

/**
 * Announce a change to every client except the one that made it.
 *
 * The asymmetric version of the above, for state that lives on disk rather than
 * on screen. A client that just wrote something already has it, and echoing the
 * change back arrives mid-edit and fights its own local state — which is why
 * conversation saves were announced only when they came from the phone.
 *
 * That gate was half a rule. It kept the desktop from echoing to itself, and in
 * doing so it stopped telling the phone anything: a conversation the computer
 * wrote was never announced to anyone, so a paired phone had no way to learn that
 * a chat it was holding had moved on. Excluding the author rather than
 * privileging one side gets the intended behaviour in both directions.
 *
 * `id` is what makes this possible — `window:<n>` for a renderer, `remote:<device>`
 * for a phone — so the author can be recognised without the caller having to know
 * which kind of client it was.
 */
export function broadcastToOtherClients(
  author: ClientChannel,
  channel: string,
  payload: unknown
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (`window:${window.webContents.id}` === author.id) continue
    sendToWindow(window, channel, payload)
  }
  for (const client of activeRemoteClients()) {
    if (client.id === author.id) continue
    client.send(channel, payload)
  }
}

/**
 * A per-token broadcast, skipping remote clients that asked for less.
 *
 * Separate from [broadcastToWindows] because the two have different costs. A
 * conversation changing is one small frame; a turn is thousands, and on a metered
 * connection that is somebody's data allowance spent on a screen they may not be
 * looking at.
 *
 * Windows always receive. The preference exists for a connection that is paid for by
 * the megabyte, which a renderer in the same process is not.
 */
export function broadcastLiveToken(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) sendToWindow(window, channel, payload)
  for (const client of activeRemoteClients()) {
    if (wantsLiveTokens(client)) client.send(channel, payload)
  }
}
