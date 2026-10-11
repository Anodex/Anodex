import type { ReminderChannel } from '@shared/scheduledTask.types'

export interface DoneNotice {
  /** What the notification says. */
  message: string
  via?: ReminderChannel[]
}

/**
 * Notices waiting for a reply to end, keyed by the reply's message id.
 *
 * Kept apart from the delivery so the chat runner can ask "is anyone waiting?"
 * at the end of every reply without loading the toast window, email and phone
 * services each time; they load only when a notice is actually there.
 */
const pending = new Map<string, DoneNotice>()

/** A later notice for the same reply replaces the earlier one. */
export function noticeAfterReply(messageId: string, notice: DoneNotice): void {
  pending.set(messageId, notice)
}

/** The notice for this reply, removed so it is delivered once. */
export function takeReplyNotice(messageId: string): DoneNotice | undefined {
  const notice = pending.get(messageId)
  pending.delete(messageId)
  return notice
}
