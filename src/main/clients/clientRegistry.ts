import type { WebContents } from 'electron'
import type { ClientChannel } from './ClientChannel'

/**
 * Adapters and the registry of non-window clients.
 *
 * Kept dependency-light on purpose — only Electron's types — so any main-process
 * service can import it without dragging in window or menu construction, the same
 * rule `broadcast.ts` follows and for the same reason.
 */

/**
 * Wrap a renderer's `WebContents`.
 *
 * The disposal handling mirrors `sendToWindow`: `isDestroyed()` closes the common
 * case, and the try/catch absorbs the residual race where the render frame is
 * disposed between the guard and the send. A reload, an in-window navigation, or a
 * renderer crash all leave a `WebContents` that looks alive and throws on send.
 */
export function webContentsChannel(sender: WebContents): ClientChannel {
  return {
    id: `window:${sender.id}`,
    send(channel, payload) {
      if (sender.isDestroyed()) return
      try {
        sender.send(channel, payload)
      } catch {
        // Frame disposed between the guard and the send — nothing to deliver.
      }
    },
    isAlive() {
      return !sender.isDestroyed()
    }
  }
}

/**
 * Clients that are not renderer windows — today, the one paired phone.
 *
 * A Set rather than a single slot even though the pairing rule allows only one
 * device at a time: "one paired phone" is a pairing constraint, not a transport
 * one, and a reconnecting client can briefly overlap with the socket it is
 * replacing. Letting that be represented is cheaper than making the reconnect
 * path race.
 */
const remoteClients = new Set<ClientChannel>()

export function attachRemoteClient(client: ClientChannel): void {
  remoteClients.add(client)
}

export function detachRemoteClient(client: ClientChannel): void {
  remoteClients.delete(client)
}

/** Every attached remote client that is still reachable, pruning any that are not. */
export function activeRemoteClients(): ClientChannel[] {
  for (const client of remoteClients) {
    if (!client.isAlive()) remoteClients.delete(client)
  }
  return [...remoteClients]
}

/** Drop every remote client. Called when the listener is turned off or the app quits. */
export function detachAllRemoteClients(): void {
  remoteClients.clear()
}
