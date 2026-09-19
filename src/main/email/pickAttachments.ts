import { dialog, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  MAX_OUTGOING_ATTACHMENT_BYTES,
  readableAttachmentSize,
  type EmailPickedAttachment
} from '@shared/email.types'

/**
 * Files chosen at the computer, read and ready to send.
 *
 * One call rather than a picker and a reader. The two together are a
 * capability that neither is on its own: a channel turning a path into bytes,
 * next to a channel that sends bytes to an address, is a way to post the
 * contents of a disk somewhere. This one only ever returns what a person
 * standing at the machine selected in a dialog, so there is no path to hand it.
 *
 * Read here rather than at send time for the same reason a mail client shows
 * you the attachment before you press send: what is attached should be what
 * was picked, not whatever is at that path several minutes later.
 */
export async function pickAttachments(
  event: IpcMainInvokeEvent,
  alreadyAttachedBytes = 0
): Promise<EmailPickedAttachment[]> {
  const window = BrowserWindow.fromWebContents(event.sender)
  const options = {
    title: 'Attach files',
    properties: ['openFile', 'multiSelections'] as const
  }

  const picked = window
    ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
    : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })

  // Cancelling is an answer, not a failure. Returning an empty list rather
  // than an error keeps "I changed my mind" out of the error surface.
  if (picked.canceled) return []

  const attachments: EmailPickedAttachment[] = []
  let total = alreadyAttachedBytes

  for (const path of picked.filePaths) {
    const info = await stat(path)
    total += info.size
    if (total > MAX_OUTGOING_ATTACHMENT_BYTES) {
      // Named, and with the arithmetic shown. "Too large" leaves somebody
      // guessing which of four files to drop; a limit and a running total
      // tells them.
      throw new Error(
        `${basename(path)} takes this message past ${readableAttachmentSize(MAX_OUTGOING_ATTACHMENT_BYTES)}, ` +
          `which is as much as most mail providers accept. ` +
          `Attached so far: ${readableAttachmentSize(total - info.size)}.`
      )
    }

    attachments.push({
      filename: basename(path),
      mimeType: mimeTypeOf(path),
      contentBase64: (await readFile(path)).toString('base64'),
      sizeBytes: info.size
    })
  }

  return attachments
}

/**
 * What kind of file this is, by its extension.
 *
 * Deliberately short, and deliberately not a lookup of every type in
 * existence. The mime type on an attachment decides how the *recipient's*
 * client offers it — inline for an image, a download for anything else — and
 * `application/octet-stream` is the honest answer for a type we do not know,
 * which every client handles by offering to save it. Guessing wrong is worse:
 * a `.docx` labelled `text/plain` opens as gibberish in a preview pane.
 */
export function mimeTypeOf(path: string): string {
  return KNOWN_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

const KNOWN_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime'
}
