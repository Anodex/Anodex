import type { EmailMessage } from '@shared/email.types'

/**
 * A message being written at the computer.
 *
 * Until now there was no such thing here. The desktop could read mail, archive
 * it, delete it and ask the model to answer it — and could not send three words
 * without a model writing them. The phone could. This is that gap closed, and
 * the shape is the phone's on purpose: the same fields in the same order, with
 * the model offered *inside* the window rather than instead of it.
 */
export interface MailDraft {
  to: string
  cc: string
  subject: string
  body: string
  /** What the window calls itself: "New message", "Reply", "Reply all", "Forward". */
  kind: string
  /** The message being answered, for threading and for the model's context. */
  inReplyTo: EmailMessage | null
  accountId?: string
}

export function blankDraft(accountId?: string): MailDraft {
  return { to: '', cc: '', subject: '', body: '', kind: 'New message', inReplyTo: null, accountId }
}

export function replyDraft(message: EmailMessage, all: boolean): MailDraft {
  return {
    to: message.from,
    // Everyone else who was on it, minus the sender — who is already in `to`,
    // and minus this account, which is how a reply-all ends up mailing you.
    cc: all
      ? [...message.to, ...message.cc]
          .filter((address) => !sameAddress(address, message.from))
          .join(', ')
      : '',
    subject: replySubject(message.subject),
    body: '',
    kind: all ? 'Reply all' : 'Reply',
    inReplyTo: message,
    accountId: message.accountId
  }
}

export function forwardDraft(message: EmailMessage): MailDraft {
  return {
    to: '',
    cc: '',
    subject: forwardSubject(message.subject),
    body: quoted(message),
    // No `inReplyTo`: a forward starts a conversation with somebody who was not
    // in the old one, and threading it onto the original files it under a
    // subject they have never seen.
    inReplyTo: null,
    kind: 'Forward',
    accountId: message.accountId
  }
}

/** `Re:` once, however many times it has been round. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`
}

export function forwardSubject(subject: string): string {
  return /^fwd?:/i.test(subject.trim()) ? subject.trim() : `Fwd: ${subject.trim()}`
}

/**
 * Whether this is ready to go.
 *
 * All three, because each missing one produces a different bad outcome: no
 * recipient cannot be sent, no subject arrives looking like spam, and an empty
 * body is a message somebody sent by accident.
 */
export function canSend(draft: MailDraft): boolean {
  return addressList(draft.to).length > 0 && draft.subject.trim() !== '' && draft.body.trim() !== ''
}

/** `a@b.com, c@d.com` as a list, forgiving about semicolons and spacing. */
export function addressList(field: string): string[] {
  return field
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean)
}

/**
 * What the model is asked, when somebody presses "Have Anodex write it".
 *
 * Deliberately the same request the phone makes, down to the closing
 * instruction. A draft written at the computer and the same draft written on
 * the phone should not read like two different assistants, and the closing line
 * is what stops it answering with "Sure! Here's a draft:" — which then gets
 * sent, because it is sitting in the body field looking like a message.
 */
export function draftPrompt(draft: MailDraft, instruction: string): string {
  const lines: string[] = []

  if (draft.inReplyTo) {
    lines.push('Write a reply to this email.', '')
    lines.push(`From: ${draft.inReplyTo.from}`)
    lines.push(`Subject: ${draft.inReplyTo.subject}`)
    lines.push('')
    // The plain-text body rather than the HTML: markup would be most of the
    // context spent on nothing the reply depends on.
    lines.push(draft.inReplyTo.body.slice(0, MAX_QUOTED_CHARS))
    lines.push('')
  } else {
    lines.push('Write an email.', '')
    const to = addressList(draft.to)
    if (to.length > 0) lines.push(`To: ${to.join(', ')}`)
    if (draft.subject.trim()) lines.push(`Subject: ${draft.subject.trim()}`)
    lines.push('')
  }

  if (instruction.trim()) {
    lines.push('What it should say:', instruction.trim(), '')
  }

  lines.push(
    'Reply with the body of the message and nothing else — no preamble, ' +
      'no subject line, no quotes around it, and no offer to revise it. ' +
      'Do not sign it with a name you have not been given.'
  )

  return lines.join('\n')
}

/** Enough of the message to answer it; the rest is usually a quoted chain. */
const MAX_QUOTED_CHARS = 4000

function quoted(message: EmailMessage): string {
  return [
    '',
    '---------- Forwarded message ----------',
    `From: ${message.from}`,
    `Subject: ${message.subject}`,
    '',
    message.body
  ].join('\n')
}

/** The bare address out of `Ada Lovelace <ada@example.com>`, compared loosely. */
function sameAddress(left: string, right: string): boolean {
  return bare(left) === bare(right)
}

function bare(address: string): string {
  const inAngles = address.split('<')[1]?.split('>')[0]
  return (inAngles ?? address).trim().toLowerCase()
}
