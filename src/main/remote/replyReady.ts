import { IpcChannel } from '@shared/ipc'
import type { RemoteNotification } from '@shared/remote.types'
import type { ClientChannel } from '../clients/ClientChannel'
import { activeRemoteClients } from '../clients/clientRegistry'
import { hasCapability } from './capabilities'

/**
 * The phone can show an "answer ready" notification the computer sends it.
 *
 * Announced by phone builds that have a connection of their own while the app is
 * closed. Older builds make that notification themselves, from their screens, and
 * would show this one as well — so it is only ever sent to a phone that asked.
 */
export const REPLY_READY_CAPABILITY = 'reply-ready.1'

/** About two lines of a notification, which is all a preview is for. */
const PREVIEW_CHARS = 140

/**
 * Tell the phone that asked a question that its answer is ready.
 *
 * The phone used to build this notification itself, from the reply streaming into
 * its screens — so a question asked from the phone and then closed went unanswered
 * as far as the phone knew: the reply finished on the computer and nothing said so.
 * Measured on a Galaxy S7. Sent only to the device that asked, since a reply is
 * not news to a second phone, and only when there is a reply to read.
 *
 * Returns how many connections it was sent to.
 */
export function notifyReplyReady(
  askedBy: ClientChannel,
  reply: { conversationId: string; title?: string | null; content: string },
  clients: readonly ClientChannel[] = activeRemoteClients()
): number {
  const preview = replyPreview(reply.content)
  if (!preview) return 0

  const notification: RemoteNotification = {
    kind: 'reply-ready',
    title: reply.title?.trim() || 'Your answer is ready',
    body: preview,
    conversationId: reply.conversationId,
    atEpochMs: Date.now()
  }
  let sent = 0
  for (const client of clients) {
    if (client.id !== askedBy.id) continue
    if (!hasCapability(client.capabilities, REPLY_READY_CAPABILITY)) continue
    client.send(IpcChannel.Remote.notification, notification)
    sent++
  }
  return sent
}

/** The opening words of a reply as plain text: no markdown marks, no line breaks. */
export function replyPreview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > PREVIEW_CHARS ? `${plain.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : plain
}
