import type { EmailMessage } from '@shared/email.types'
import { identityKey, parseSender, type Sender } from './threadRow'

const DAY_MS = 24 * 60 * 60 * 1000

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

/**
 * Everyone who has spoken in the thread, newest first.
 *
 * Deduplicated on identity rather than on the raw `From`, so one person who
 * changed their display name — or wrote from two addresses at the same
 * company — is one participant rather than two.
 */
export function threadParticipants(messages: EmailMessage[]): Sender[] {
  const seen = new Set<string>()
  const participants: Sender[] = []
  for (const message of orderThreadMessagesNewestFirst(messages)) {
    const sender = parseSender(message.from)
    const key = identityKey(sender.address) + sender.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    participants.push(sender)
  }
  return participants
}

/**
 * True when this message came from the mailbox being read.
 *
 * Worth knowing because the reader shows a conversation, and a conversation
 * where both halves are labelled with an address reads as neither: the
 * account's own replies are the ones it never needs to name.
 */
export function isSelfSender(sender: Sender, selfAddress: string | undefined): boolean {
  if (!selfAddress) return false
  return sender.address.trim().toLowerCase() === selfAddress.trim().toLowerCase()
}

/** `You` for the account's own messages, the sender's name for everyone else. */
export function senderDisplayName(sender: Sender, selfAddress: string | undefined): string {
  return isSelfSender(sender, selfAddress) ? 'You' : sender.name
}

/**
 * A timestamp on a message inside an open thread.
 *
 * `toLocaleString()` gave `7/25/2026, 2:40:11 PM` on every message: the
 * seconds are never useful, and the year is already in the thread's date span
 * two lines above. What is actually being asked here is "how long ago, and was
 * that before or after the one below it".
 */
export function formatMessageTime(timestamp: number, now = Date.now(), locale?: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date(now)
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })

  // Calendar days rather than elapsed hours, so a message sent at 11pm
  // yesterday does not read as today from 8am.
  const daysApart = Math.round((startOfDay(today) - startOfDay(date)) / DAY_MS)
  if (daysApart === 0) return `Today ${time}`
  if (daysApart > 0 && daysApart < 7) {
    return `${date.toLocaleDateString(locale, { weekday: 'short' })} ${time}`
  }

  const day = date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
  return `${day}, ${time}`
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function sortableDate(message: EmailMessage): number {
  return Number.isFinite(message.date) ? message.date : Number.NEGATIVE_INFINITY
}
