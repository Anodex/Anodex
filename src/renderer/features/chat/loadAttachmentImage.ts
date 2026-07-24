import type { ChatAttachment } from '@shared/chat.types'
import { anodex } from '../../lib/anodex'
import { isAbsoluteAttachmentPath } from '../../lib/attachments'

/** Reopen persisted attachment metadata without putting image bytes in chat JSON. */
export async function loadAttachmentImage(attachment: ChatAttachment): Promise<string | null> {
  try {
    let readPath = attachment.path
    if (!isAbsoluteAttachmentPath(readPath)) {
      const resolved = await anodex.workspace.getAbsolutePath(readPath)
      if (!resolved.ok) return null
      readPath = resolved.value
    }
    const result = await anodex.attachments.readFile(readPath)
    return result.ok && result.value.kind === 'image' ? result.value.dataUrl : null
  } catch {
    return null
  }
}
