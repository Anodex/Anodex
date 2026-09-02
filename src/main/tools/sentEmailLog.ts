import { findDuplicateSend, sendFingerprint, type SentEmailRecord } from '@shared/sendDeduplication'

/**
 * What this conversation has already sent, so the approval card can say so.
 *
 * In memory and per process, deliberately. The failure it addresses happens
 * inside a single conversation, usually within minutes: a model denies a send
 * it made and sends again. Persisting this would buy warnings about messages
 * from last week, which is not the problem and would mean writing a record of
 * every email sent to disk for no benefit.
 *
 * See `sendDeduplication.ts` for the measured duplicate that prompted it.
 */

/** Per conversation. A chat that sends more than this is not the case guarded. */
const MAX_RECORDS_PER_CONVERSATION = 50

const byConversation = new Map<string, SentEmailRecord[]>()

/** Note a send that succeeded, so a repeat of it can be recognised. */
export function recordSentEmail(
  conversationId: string,
  message: { to: readonly string[]; subject: string; body: string }
): void {
  const records = byConversation.get(conversationId) ?? []
  records.push({
    fingerprint: sendFingerprint(message),
    at: Date.now(),
    to: [...message.to],
    subject: message.subject
  })
  // Oldest first out. A conversation past the cap has long since stopped being
  // the "sent the same thing twice by accident" case this exists for.
  byConversation.set(conversationId, records.slice(-MAX_RECORDS_PER_CONVERSATION))
}

/** The most recent identical send in this conversation, or null. */
export function findRecentDuplicateSend(
  conversationId: string,
  message: { to: readonly string[]; subject: string; body: string }
): SentEmailRecord | null {
  const records = byConversation.get(conversationId)
  if (!records?.length) return null
  return findDuplicateSend(records, sendFingerprint(message), Date.now())
}

/** Test seam: drop everything remembered. */
export function resetSentEmailLog(): void {
  byConversation.clear()
}
