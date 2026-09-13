import { nativeImage } from 'electron'
import { isAbsolute } from 'node:path'
import type { RemoteAttachmentPreview } from '@shared/conversation.types'
import { readAttachmentFile } from '../ipc/attachments.handlers'
import { settingsStore } from '../settings/SettingsStore'
import { resolveInWorkspace } from '../tools/workspace'
import { createLogger } from '../utils/logger'
import { conversationStore } from './ConversationStore'

const log = createLogger('conversations:attachment-preview')

/** The long edge a phone gets. Sharp on a phone's chat bubble, a fraction of the original. */
export const PREVIEW_EDGE = 1080

/** Past this the picture is re-encoded smaller; a response frame has to carry it. */
export const PREVIEW_MAX_BYTES = 180 * 1024

/**
 * A picture attached to a message, sized for a phone.
 *
 * The phone's copy of a conversation carries no image bytes — `forRemote` sends each
 * attachment's name and kind only — so a picture sent from the computer, or one the
 * phone sent and later reopened, showed nothing at all. This is how it gets the
 * picture.
 *
 * Addressed by conversation, message and position, never by path. The phone can only
 * ask for a picture that a message it can already read actually has; it cannot name
 * a file. Anything that does not resolve to such a picture answers null.
 */
export async function attachmentPreview(
  conversationId: string,
  messageId: string,
  index: number
): Promise<RemoteAttachmentPreview | null> {
  if (typeof conversationId !== 'string' || typeof messageId !== 'string') return null
  if (!Number.isInteger(index) || index < 0) return null

  const message = conversationStore.get(conversationId)?.messages.find((m) => m.id === messageId)
  const attachment = message?.attachments?.[index]
  if (!attachment || attachment.kind === 'text') return null

  const absolute = resolveAttachmentPath(attachment.path)
  if (!absolute) return null

  const read = await readAttachmentFile(absolute)
  if (!read.ok || read.value.kind !== 'image') return null

  try {
    const data = Buffer.from(
      read.value.dataUrl.slice(read.value.dataUrl.indexOf(',') + 1),
      'base64'
    )
    const decoded = nativeImage.createFromBuffer(data)
    if (decoded.isEmpty()) return null

    const size = decoded.getSize()
    const scaled =
      Math.max(size.width, size.height) > PREVIEW_EDGE
        ? decoded.resize(
            size.width >= size.height
              ? { width: PREVIEW_EDGE, quality: 'good' }
              : { height: PREVIEW_EDGE, quality: 'good' }
          )
        : decoded

    const encoded = encodeWithin(scaled, PREVIEW_MAX_BYTES)
    if (!encoded) return null
    const final = encoded.image.getSize()
    return {
      mimeType: 'image/jpeg',
      base64: encoded.bytes.toString('base64'),
      width: final.width,
      height: final.height
    }
  } catch (error) {
    log.warn('Could not prepare an attachment preview:', error)
    return null
  }
}

/** JPEG at falling quality, then smaller, until it fits. Null if it never does. */
function encodeWithin(
  image: Electron.NativeImage,
  maxBytes: number
): { image: Electron.NativeImage; bytes: Buffer } | null {
  let working = image
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const quality of [80, 65, 50]) {
      const bytes = working.toJPEG(quality)
      if (bytes.length > 0 && bytes.length <= maxBytes) return { image: working, bytes }
    }
    const { width } = working.getSize()
    working = working.resize({ width: Math.max(1, Math.round(width * 0.7)), quality: 'good' })
  }
  return null
}

/** An attachment path as stored: absolute from a drop, or relative to the workspace. */
function resolveAttachmentPath(path: string): string | null {
  if (!path) return null
  if (isAbsolute(path)) return path
  const root = settingsStore.get().workspace.root
  if (!root) return null
  try {
    return resolveInWorkspace(root, path)
  } catch {
    return null
  }
}
