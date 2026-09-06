import { IpcChannel } from '@shared/ipc'
import type { RemoteNotification, RemoteNotificationKind } from '@shared/remote.types'
import type { ToastContent } from '@shared/toast.types'
import { activeRemoteClients } from './clients/clientRegistry'
import { showToastWindow } from './toastWindow'

/**
 * Tell the user something happened, wherever they are.
 *
 * This is the seam §6.2 describes. `showToastWindow` already had almost exactly
 * the right set of call sites — a run finishing, a run failing, a scheduled task
 * completing — and each one is worth a phone buzz for the same reason it is worth
 * a toast: the user asked for something long-running and is not watching it.
 *
 * **Four of the five `showToastWindow` call sites belong here; the fifth does
 * not.** `toast.handlers.ts` is the renderer's own toast channel, and everything
 * the UI raises through it — settings saved, text copied — is feedback about a
 * click that already happened. Routing those to a phone would make it buzz for
 * "Settings saved", which is precisely the outcome the notify/don't-notify split
 * exists to prevent.
 *
 * Kept as its own module rather than folded into `toastWindow` so that a caller
 * importing it does not drag in window construction.
 */
export function notifyUser(content: ToastContent, kind: RemoteNotificationKind = 'finished'): void {
  showToastWindow(content)

  notifyRemoteClients({
    kind,
    title: content.title,
    // Kept thin deliberately: this renders on a lock screen, and §2 says the phone
    // does not hold the user's data. "Backfill test coverage finished" is fine;
    // the tool output that produced it is not.
    body: content.body,
    conversationId: content.conversationId,
    atEpochMs: Date.now()
  })
}

/**
 * Notify the phone without raising a desktop toast.
 *
 * For the cases where the desktop is already showing the thing itself — an
 * approval card on screen does not also need a toast about an approval card.
 */
export function notifyRemoteClients(notification: RemoteNotification): void {
  for (const client of activeRemoteClients()) {
    client.send(IpcChannel.Remote.notification, notification)
  }
}
