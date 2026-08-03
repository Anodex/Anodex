import type { AttachmentContent } from '@shared/chat.types'
import type { Result } from '@shared/result'

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

/** Keeps a single turn's attached content bounded — mirrors the old read_file cap. */
export const MAX_ATTACHMENTS = 10
/** Keeps image payloads and multimodal prompt processing predictably bounded. */
export const MAX_IMAGE_ATTACHMENTS = 4

/**
 * Everything `intakeAttachments` needs from its caller. `getAttachments` is a
 * getter rather than a value on purpose: the intake awaits a read per file,
 * and the list can grow underneath it while it waits.
 */
export interface AttachmentIntake {
  getAttachments: () => ComposerAttachment[]
  commit: (update: (current: ComposerAttachment[]) => ComposerAttachment[]) => void
  readFile: (path: string) => Promise<Result<AttachmentContent>>
  notifyError: (title: string, message: string) => void
  visionAvailable: boolean
}

/**
 * Read each candidate and append the ones that fit.
 *
 * Lives here rather than inside `ChatComposer` because the sequencing is the
 * whole point of it and needs to be exercised directly: the composer renders
 * under a server renderer in tests, so nothing that only exists as a closure
 * inside the component can be driven through an interleaving.
 *
 * Every admission decision reads `getAttachments()` again *after* the file
 * read resolves. The version this replaced counted from a single snapshot
 * taken before the loop, which is correct for one pass and wrong for two:
 * a second drop (or the file picker, which does not wait for a drop to
 * finish) starts its own pass, and both measure the list as it was before
 * either added anything. The caps then admit twice their limit, and the same
 * file offered to both passes clears both duplicate checks — which matters
 * most, because `path` is the attachment list's React key and the only thing
 * the remove button filters on, so two entries sharing one path render as
 * duplicate keys and removing either removes both.
 */
export async function intakeAttachments(
  candidates: { path: string; name: string }[],
  intake: AttachmentIntake
): Promise<void> {
  // One notice per pass, however many candidates are left over — reporting per
  // file turned a ten-file drop onto a full list into ten separate toasts.
  let reportedFull = false
  const reportFull = (): void => {
    if (reportedFull) return
    reportedFull = true
    // States the limit rather than a count of what was taken. The old wording
    // ("only the first 10 files were added") was wrong in both directions: it
    // claimed ten additions when the list was already full and none were
    // added, and still named ten when only two of five had fit.
    intake.notifyError(
      'Too many attachments',
      `A message can carry ${MAX_ATTACHMENTS} files. The rest were skipped.`
    )
  }

  for (const { path, name } of candidates) {
    if (intake.getAttachments().length >= MAX_ATTACHMENTS) {
      reportFull()
      return
    }
    if (intake.getAttachments().some((attachment) => attachment.path === path)) continue

    const result = await intake.readFile(path)
    if (!result.ok) {
      intake.notifyError('Could not attach file', result.error.message)
      continue
    }

    // Re-read after the await, not just before it. Nothing from here to the
    // commit yields, so this is the only point at which the list a decision is
    // made against is still the list the decision is applied to.
    const current = intake.getAttachments()
    if (current.length >= MAX_ATTACHMENTS) {
      reportFull()
      return
    }
    if (current.some((attachment) => attachment.path === path)) continue

    if (result.value.kind === 'image') {
      const image = result.value
      if (!intake.visionAvailable) {
        intake.notifyError(
          'Vision model required',
          'Load a local vision model with its matching mmproj projector, or select an image-capable cloud model.'
        )
        continue
      }
      const imageCount = current.filter((attachment) => attachment.kind === 'image').length
      if (imageCount >= MAX_IMAGE_ATTACHMENTS) {
        intake.notifyError(
          'Too many images',
          `Only ${MAX_IMAGE_ATTACHMENTS} images can be sent in one message.`
        )
        continue
      }
      intake.commit((prev) => [
        ...prev,
        {
          kind: 'image',
          path,
          name,
          dataUrl: image.dataUrl,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes
        }
      ])
      continue
    }

    const { content, sizeBytes, truncated } = result.value
    intake.commit((prev) => [...prev, { kind: 'text', path, name, content, sizeBytes, truncated }])
  }
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
