import { anodex } from '../../lib/anodex'
import { isAbsoluteAttachmentPath } from '../../lib/attachments'

/**
 * Reopen persisted attachment metadata without putting image bytes in chat JSON.
 *
 * Takes the path rather than the attachment so the caller can depend on a
 * stable string: an effect keyed on the attachment *object* re-ran on every
 * parent render and re-read the file each time. For an attachment whose file
 * has since been deleted that meant a fresh failed disk read, and a warning in
 * the log, per render -- 81 of them for one screenshot removed days earlier.
 */
export async function loadAttachmentImage(path: string): Promise<string | null> {
  try {
    let readPath = path
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
