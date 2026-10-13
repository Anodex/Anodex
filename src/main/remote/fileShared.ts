import { IpcChannel } from '@shared/ipc'
import type { RemoteNotification } from '@shared/remote.types'
import type { ClientChannel } from '../clients/ClientChannel'
import { activeRemoteClients } from '../clients/clientRegistry'
import { hasCapability } from './capabilities'
import { FILES_CAPABILITY, type PhoneShare } from '../files/phoneShares'

/**
 * Tell each connected phone that can collect files that one is waiting for it.
 *
 * Only a phone that announced `files.1`: an older one would show a notification
 * for a file it has no way to fetch. A phone that is not connected finds the file
 * on the shelf the next time it is. Returns how many phones were told.
 */
export function notifyFileShared(
  share: PhoneShare,
  clients: readonly ClientChannel[] = activeRemoteClients()
): number {
  const notification: RemoteNotification = {
    kind: 'file-shared',
    title: 'A file from your computer',
    body: share.name,
    fileId: share.id,
    atEpochMs: Date.now()
  }
  let sent = 0
  for (const client of clients) {
    if (!hasCapability(client.capabilities, FILES_CAPABILITY)) continue
    client.send(IpcChannel.Remote.notification, notification)
    sent++
  }
  return sent
}
