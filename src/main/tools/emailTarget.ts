import { emailService } from '../email/EmailService'

/** The email a tool will act on, named the way the person sees it. */
export interface EmailTarget {
  threadId?: string
  messageId?: string
  /** `"Subject" from Sender`, for the confirmation card. */
  label: string
}

/**
 * The email `threadId` or `messageId` means: an id as given, or, when a model
 * passed words instead of an id, the one email those words find.
 *
 * Measured on 17 email questions: "Instagram", "Reddit email titled Wtf." and a
 * copied block of `[threadId: …; latestMessageId: …]` were each passed as a
 * thread id and refused, and the confirmation card showed the model's words,
 * not the email. One of those runs then trashed "Welcome to Google on your
 * Windows" in place of the Reddit email asked for. So this runs before the
 * card: the card names the real email, and words that find several emails list
 * them rather than picking one.
 */
export async function resolveEmailTarget(ref: {
  threadId?: string
  messageId?: string
  account?: string
}): Promise<EmailTarget> {
  const given = (ref.messageId ?? ref.threadId ?? '').trim()
  if (!given) throw new Error('Name the email by its thread id, message id or subject.')

  if (ref.messageId) {
    const message = await emailService.readMessage(given, ref.account).catch(() => null)
    if (message) return { messageId: given, label: labelFor(message.subject, message.from) }
  } else {
    const messages = await emailService.getThreadMessages(given, ref.account).catch(() => null)
    const latest = messages?.at(-1)
    if (latest) return { threadId: given, label: labelFor(latest.subject, latest.from) }
  }

  // A listing line copied whole: "[threadId: subj.…; latestMessageId: …] Subject".
  const copied = /threadId:\s*([^\s;\]]+)/.exec(given)?.[1]
  if (copied && copied !== given)
    return resolveEmailTarget({ threadId: copied, account: ref.account })

  const words = wordsFrom(given)
  if (!words) throw new Error(`"${given}" is not an email id, and names no email to search for.`)
  let found = await emailService.search({ query: words, limit: 10, accountId: ref.account })
  // "Reddit Wtf.": the sender and the subject, which no single search holds
  // together. The most distinctive word, then every word in subject or sender.
  const parts = words.split(' ').map((word) => word.toLowerCase().replace(/[.!?,;:]+$/, ''))
  if (found.length === 0 && parts.length > 1) {
    const longest = [...parts].sort((a, b) => b.length - a.length)[0]
    const wide = await emailService.search({ query: longest, limit: 30, accountId: ref.account })
    found = wide.filter((thread) => {
      const haystack = `${thread.subject} ${thread.from}`.toLowerCase()
      return parts.every((part) => haystack.includes(part))
    })
  }
  const exact = found.filter((thread) => sameWords(thread.subject, words))
  const matches = exact.length > 0 ? exact : found
  if (matches.length === 1) {
    return { threadId: matches[0].id, label: labelFor(matches[0].subject, matches[0].from) }
  }
  if (matches.length === 0) throw new Error(`No email matches "${words}".`)
  throw new Error(
    [
      `More than one email matches "${words}". Give the thread id of the one meant:`,
      ...matches
        .slice(0, 8)
        .map((thread) => `- ${labelFor(thread.subject, thread.from)}: ${thread.id}`)
    ].join('\n')
  )
}

function labelFor(subject: string, from: string): string {
  return `"${subject || '(no subject)'}" from ${from || 'an unknown sender'}`
}

/**
 * What to search for in words a model passed as an id: a quoted part if there
 * is one ("Wtf."), otherwise the words left once the ones describing an email
 * rather than naming it are taken out.
 */
function wordsFrom(text: string): string {
  const quoted = /["“']([^"”']{2,})["”']/.exec(text)?.[1]
  if (quoted) return quoted.trim()
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(
      /\b(?:the|an?|e-?mails?|messages?|threads?|titled|called|named|subject|about|from|latest|newest|one)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()
}

function sameWords(a: string, b: string): boolean {
  const plain = (text: string): string =>
    text
      .toLowerCase()
      .replace(/["“”'.!?,:;]/g, '')
      .trim()
  return plain(a) === plain(b)
}
