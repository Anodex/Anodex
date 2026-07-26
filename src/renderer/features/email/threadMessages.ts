import type { EmailMessage } from '@shared/email.types'

/**
 * The reading order used by the email surface.
 *
 * Providers normalize a thread chronologically because summaries and model
 * context read naturally from oldest to newest. The human reader is different:
 * reopening a conversation is usually about the reply that just arrived, so
 * the visible thread starts with the newest message.
 */
export function orderThreadMessagesNewestFirst(messages: EmailMessage[]): EmailMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort(
      (left, right) =>
        sortableDate(right.message) - sortableDate(left.message) || right.index - left.index
    )
    .map(({ message }) => message)
}

/** The message Reply and the linked assistant conversation should target. */
export function newestThreadMessage(messages: EmailMessage[]): EmailMessage | null {
  return orderThreadMessagesNewestFirst(messages)[0] ?? null
}

/** Compact calendar span shown beneath the subject in the thread reader. */
export function formatThreadDateSpan(
  messages: EmailMessage[],
  now = Date.now(),
  locale?: string
): string {
  const timestamps = messages
    .map(sortableDate)
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => left - right)
  if (timestamps.length === 0) return ''

  const first = new Date(timestamps[0])
  const last = new Date(timestamps[timestamps.length - 1])
  const currentYear = new Date(now).getFullYear()
  const includeYear =
    first.getFullYear() !== last.getFullYear() || last.getFullYear() !== currentYear
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: includeYear ? 'numeric' : undefined
  }
  const firstLabel = first.toLocaleDateString(locale, options)
  const lastLabel = last.toLocaleDateString(locale, options)
  return firstLabel === lastLabel ? firstLabel : `${firstLabel} – ${lastLabel}`
}

function sortableDate(message: EmailMessage): number {
  return Number.isFinite(message.date) ? message.date : Number.NEGATIVE_INFINITY
}
