import type { EmailMessage } from '@shared/email.types'
import { extractAddress } from './mime'
import { stripQuotedReply } from './quotedText'

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
