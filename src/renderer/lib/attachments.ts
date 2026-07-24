/**
 * Custom drag-data MIME type used to identify a drag originating from
 * Anodex's own Files panel (as opposed to a native OS file drop), carrying
 * `{ path, name }` as JSON — `path` is workspace-relative, resolved to an
 * absolute path via `anodex.workspace.getAbsolutePath` on drop.
 */
export const ANODEX_FILE_DRAG_TYPE = 'application/x-anodex-file'

/** True for OS-absolute paths; workspace drags intentionally retain relative paths. */
export function isAbsoluteAttachmentPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

interface ComposerAttachmentBase {
  /** Absolute path (OS drop) or workspace-relative path (Files panel drag). */
  path: string
  name: string
  sizeBytes: number
}

/** A text/code file whose content is folded into the current prompt. */
export interface ComposerTextAttachment extends ComposerAttachmentBase {
  kind: 'text'
  content: string
  truncated: boolean
}

/** An image passed as a real multimodal content part, never inserted into text. */
export interface ComposerImageAttachment extends ComposerAttachmentBase {
  kind: 'image'
  dataUrl: string
  mimeType: string
}

/** A file read into the composer, ready to be sent with the next message. */
export type ComposerAttachment = ComposerTextAttachment | ComposerImageAttachment

/**
 * Formats attached files as clearly-delimited blocks ahead of the user's typed
 * text, so the model receives the full content directly in this turn's prompt
 * with no tool call required. Only affects the string sent to the model —
 * callers keep the user's original typed text as the message's own `content`
 * for clean display and future-turn history replay.
 */
export function buildPromptWithAttachments(
  text: string,
  attachments: ComposerAttachment[]
): string {
  const textAttachments = attachments.filter(
    (attachment): attachment is ComposerTextAttachment => attachment.kind === 'text'
  )
  if (textAttachments.length === 0) return text
  const blocks = textAttachments
    .map((attachment) => {
      const note = attachment.truncated
        ? ` (truncated, showing first ${attachment.content.length} of ${attachment.sizeBytes} bytes)`
        : ''
      return `--- Attached file: ${attachment.path}${note} ---\n${attachment.content}`
    })
    .join('\n\n')
  return text ? `${blocks}\n\n${text}` : blocks
}
