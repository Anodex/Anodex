import type { EmailAttachmentSummary, EmailMessage } from '@shared/email.types'
import { extractAddress } from './mime'
import { stripQuotedReply } from './quotedText'
import { isVisionImageMimeType } from '../vision/imageInputs'
import { isReadableAttachmentType } from './attachmentText'

/**
 * How much of one message a thread summary shows the model. Larger than the 180
 * characters it used to be because the quoted history no longer eats the
 * allowance — before `stripQuotedReply`, a reply's share went on re-reading the
 * message above it and was cut off mid-word before reaching anything new.
 */
export const MAX_THREAD_PREVIEW = 400

/**
 * One message's contribution to a thread summary: the new words only. Prefers
 * the de-quoted body and falls back to the provider snippet, which is all there
 * is when an account syncs metadata only.
 *
 * The fallback is genuinely worse, not merely different: `stripQuotedReply`
 * anchors its markers to line starts so it can't cut mid-sentence prose, and a
 * provider snippet is typically one collapsed line, so quoted text usually
 * survives it. Hence body-first whenever there is a body at all.
 */
export function threadPreview(message: Pick<EmailMessage, 'body' | 'snippet'>): string {
  const body = stripQuotedReply(message.body).trim()
  if (body) return truncate(body, MAX_THREAD_PREVIEW)
  return truncate(stripQuotedReply(message.snippet).trim(), MAX_THREAD_PREVIEW)
}

/**
 * One attachment as the model sees it, carrying the ids every attachment tool
 * needs handed back.
 *
 * Images say so in words and name the tool that opens them. A filename, a MIME
 * type, and a byte count are not enough of a cue on their own — given exactly
 * that, a model reports it cannot see the picture and stops, which is the
 * behavior this path exists to fix. The hint is conditional because pointing at
 * a tool that was never registered (a text-only model) would send it chasing
 * something that cannot work.
 */
export function describeAttachment(
  attachment: EmailAttachmentSummary,
  canViewImages: boolean
): string {
  const line = `${attachment.filename} (messageId: ${attachment.messageId}; attachmentId: ${attachment.id}; ${attachment.mimeType}; ${attachment.size} bytes)`
  if (isVisionImageMimeType(attachment.mimeType)) {
    return canViewImages
      ? `${line} — image; call view_email_attachment with these ids to see what it shows`
      : `${line} — image, which the active model cannot view`
  }
  if (isReadableAttachmentType(attachment.mimeType, attachment.filename)) {
    return `${line} — document; call read_email_attachment with these ids to read it`
  }
  return line
}

/**
 * What a message carried, for surfaces with no room for ids — currently the
 * inbox row digests.
 *
 * Worth its own line because a message whose entire content is a photo has an
 * empty body and an empty snippet: without this the digest model is asked to
 * describe nothing at all, and the row ends up blanker than the raw snippet it
 * replaced.
 */
export function describeAttachmentsBriefly(
  attachments: readonly EmailAttachmentSummary[]
): string | null {
  if (attachments.length === 0) return null
  const named = attachments
    .slice(0, 4)
    .map(
      (attachment) =>
        `${attachment.filename}${isVisionImageMimeType(attachment.mimeType) ? ' (image)' : ''}`
    )
    .join(', ')
  const rest = attachments.length - Math.min(attachments.length, 4)
  return `[attached: ${named}${rest > 0 ? `, and ${rest} more` : ''}]`
}

/**
 * Collapses a thread's From/To values to one entry per mailbox, keeping the
 * first spelling seen so a display name survives. Comparing the raw header
 * strings listed the same person twice whenever two messages spelled them
 * differently — a real summary showed `Invictioncraft@gmail.com` next to
 * `Invictioncraft@gmail.com <invictioncraft@gmail.com>`.
 */
export function dedupeParticipants(values: readonly string[]): string[] {
  const byAddress = new Map<string, string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = extractAddress(trimmed).toLowerCase()
    if (!byAddress.has(key)) byAddress.set(key, trimmed)
  }
  return [...byAddress.values()]
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}
