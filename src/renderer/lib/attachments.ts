/**
 * Custom drag-data MIME type used to identify a drag originating from
 * Anodex's own Files panel (as opposed to a native OS file drop), carrying
 * `{ path, name }` as JSON — `path` is workspace-relative, resolved to an
 * absolute path via `anodex.workspace.getAbsolutePath` on drop.
 */
export const ANODEX_FILE_DRAG_TYPE = 'application/x-anodex-file'

/** A file read into the composer, ready to be sent with the next message. */
export interface ComposerAttachment {
  /** Absolute path (OS drop) or workspace-relative path (Files panel drag). */
  path: string
  name: string
  content: string
  sizeBytes: number
  truncated: boolean
}

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
  if (attachments.length === 0) return text
  const blocks = attachments
    .map((attachment) => {
      const note = attachment.truncated
        ? ` (truncated, showing first ${attachment.content.length} of ${attachment.sizeBytes} bytes)`
        : ''
      return `--- Attached file: ${attachment.path}${note} ---\n${attachment.content}`
    })
    .join('\n\n')
  return text ? `${blocks}\n\n${text}` : blocks
}
