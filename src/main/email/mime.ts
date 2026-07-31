import { randomBytes } from 'node:crypto'
import type { EmailOutgoingAttachment } from '@shared/email.types'

/** A message ready to be handed to a provider, after draft/reply resolution. */
export interface OutgoingMessage {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  attachments: EmailOutgoingAttachment[]
  /** Message-ID of the message being replied to, for `In-Reply-To`. */
  inReplyTo?: string
  /** Full ancestry chain, for `References`. */
  references?: string[]
  /** Provider-side thread to attach this message to, when the provider has one. */
  threadId?: string
}

/**
 * Builds an RFC 5322 message for providers that take raw MIME (Gmail).
 *
 * Bodies are base64-encoded rather than sent as-is: an 8-bit UTF-8 body with
 * long lines is not valid in a 7-bit transport, and the previous plain-text
 * builder silently produced malformed messages for non-ASCII content. Headers
 * with non-ASCII characters get RFC 2047 encoded-word treatment for the same
 * reason.
 */
export function buildMimeMessage(message: OutgoingMessage): string {
  const headers: string[] = [
    `To: ${encodeAddressList(message.to)}`,
    message.cc.length ? `Cc: ${encodeAddressList(message.cc)}` : null,
    message.bcc.length ? `Bcc: ${encodeAddressList(message.bcc)}` : null,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    message.inReplyTo ? `In-Reply-To: ${message.inReplyTo}` : null,
    message.references?.length ? `References: ${message.references.join(' ')}` : null,
    'MIME-Version: 1.0'
  ].filter((line): line is string => line !== null)

  if (message.attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(message.body, 'utf-8').toString('base64'))
    ].join('\r\n')
  }

  const boundary = `anodex_${randomBytes(16).toString('hex')}`
  const parts = [
    [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(message.body, 'utf-8').toString('base64'))
    ].join('\r\n'),
    ...message.attachments.map((attachment) =>
      [
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${escapeQuoted(attachment.filename)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${escapeQuoted(attachment.filename)}"`,
        '',
        wrapBase64(attachment.contentBase64)
      ].join('\r\n')
    )
  ]

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts,
    `--${boundary}--`,
    ''
  ].join('\r\n')
}

/**
 * Assembles the `References` chain for a reply: the original chain plus the
 * message being answered. Per RFC 5322 the parent's Message-ID goes last, and
 * duplicates are dropped so a long back-and-forth doesn't grow quadratically.
 */
export function buildReferences(
  parentReferences: readonly string[] | undefined,
  parentMessageId: string | undefined
): string[] {
  const chain = [...(parentReferences ?? [])]
  if (parentMessageId) chain.push(parentMessageId)
  return Array.from(new Set(chain.filter(Boolean)))
}

/** Splits a raw `References`/`In-Reply-To` header into individual message ids. */
export function parseReferences(value: string | undefined): string[] {
  if (!value) return []
  return value.match(/<[^>]+>/g) ?? []
}

/** `Subject: Re: ...`, without stacking a second `Re:` on an existing reply. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim()
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed || '(no subject)'}`
}

/**
 * `Subject: Fwd: ...`. Accepts the `FW:` other clients use as an existing
 * marker, so a message forwarded onward from Outlook doesn't become
 * "Fwd: FW: ...".
 */
export function forwardSubject(subject: string): string {
  const trimmed = subject.trim()
  return /^(fwd?|fw):/i.test(trimmed) ? trimmed : `Fwd: ${trimmed || '(no subject)'}`
}

/**
 * The attribution block every mail client puts above a forwarded message.
 *
 * Kept deliberately close to the conventional wording: the recipient needs to
 * see who originally wrote this and when, and a forward that merely pastes the
 * body reads as if the sender wrote it themselves.
 */
export function forwardedHeader(original: {
  from: string
  to: readonly string[]
  cc?: readonly string[]
  subject: string
  date: number
}): string {
  return [
    '---------- Forwarded message ----------',
    `From: ${original.from}`,
    `Date: ${new Date(original.date).toLocaleString()}`,
    `Subject: ${original.subject}`,
    `To: ${original.to.join(', ')}`,
    original.cc?.length ? `Cc: ${original.cc.join(', ')}` : null
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

/**
 * Gmail caps a message at 25MB *after* base64 expansion (~33% overhead), and
 * the other providers sit near the same mark. Capping the raw total at 18MB
 * keeps an encoded message under every provider's limit, and fails locally with
 * a clear message rather than as an opaque provider rejection at send time.
 */
export const MAX_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024

/**
 * Picks the addresses a reply goes to. `replyAll` keeps every original
 * participant except the account's own address, which would otherwise mail the
 * user a copy of their own reply on every send.
 */
export function replyRecipients(options: {
  from: string
  to: readonly string[]
  cc: readonly string[]
  replyTo?: string
  selfAddress: string
  replyAll: boolean
}): { to: string[]; cc: string[] } {
  const primary = options.replyTo?.trim() || options.from.trim()
  if (!options.replyAll) return { to: primary ? [primary] : [], cc: [] }

  const isSelf = (address: string): boolean =>
    extractAddress(address).toLowerCase() === options.selfAddress.trim().toLowerCase()

  const seen = new Set<string>()
  const dedupe = (addresses: readonly string[]): string[] =>
    addresses.filter((address) => {
      const key = extractAddress(address).toLowerCase()
      if (!key || seen.has(key) || isSelf(address)) return false
      seen.add(key)
      return true
    })

  return { to: dedupe([primary, ...options.to]), cc: dedupe(options.cc) }
}

/** Pulls `user@host` out of a `Display Name <user@host>` header value. */
export function extractAddress(value: string): string {
  const angled = value.match(/<([^>]+)>/)
  return (angled ? angled[1] : value).trim()
}

export function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function decodeBase64Url(value: string): string {
  return decodeBase64UrlBuffer(value).toString('utf-8')
}

export function decodeBase64UrlBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** Reduces an HTML body to readable text when no text/plain part exists. */
export function htmlToPlainText(html: string): string {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      // Stripping a tag leaves a space behind, so a `<p>` right after a break
      // would otherwise indent every paragraph by one character.
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

function encodeAddressList(addresses: readonly string[]): string {
  return addresses.map(encodeHeaderValue).join(', ')
}

/**
 * RFC 2047 encoded word for header values containing non-ASCII. Plain ASCII is
 * left alone so ordinary headers stay human-readable on the wire.
 */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`
}

/** MIME caps encoded lines at 76 characters. */
function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join('\r\n')
}

function escapeQuoted(value: string): string {
  return value.replace(/["\\]/g, '_').replace(/[\r\n]/g, '')
}
