/**
 * What an inbox row shows, derived from what the providers actually hand over.
 *
 * All of it is pure and none of it touches React, because every one of these
 * is a small pile of special cases that is much easier to argue with in a test
 * than through the UI.
 */

/** `Spotify <no-reply@spotify.com>` split into its two halves. */
export interface Sender {
  /** What to show. Falls back to the address when there is no display name. */
  name: string
  address: string
}

const ANGLE_ADDRESSED = /^\s*(.*?)\s*<([^>]*)>\s*$/

/**
 * Subdomains a brand sends from rather than is known by. `claude.com` and
 * `email.claude.com` are the same correspondent to a reader, so they have to
 * reduce to the same label — otherwise they get different avatar colours and
 * the whole point of a stable identity is lost.
 */
const SENDING_LABELS = new Set([
  'e',
  'em',
  'email',
  'm',
  'mail',
  'mailer',
  'mailing',
  'news',
  'newsletter',
  'notification',
  'notifications',
  'reply',
  'send',
  'smtp',
  'updates'
])

/** Registry second levels that never identify the brand: the `co` of `co.uk`. */
const SUFFIX_LABELS = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org'])

/**
 * Domains where the brand is the mail provider rather than the correspondent.
 * Everyone at gmail.com is a different person, so these key on the whole
 * address — without this, every personal contact would share one colour.
 */
const CONSUMER_DOMAINS = new Set([
  'aol.com',
  'fastmail.com',
  'gmail.com',
  'gmx.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mail.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'yandex.com',
  'zoho.com'
])

export function parseSender(from: string): Sender {
  const addressed = ANGLE_ADDRESSED.exec(from)
  if (!addressed) {
    const bare = from.trim()
    return { name: bare, address: bare }
  }
  const address = addressed[2].trim()
  const name = unquote(addressed[1])
  // An empty display name is common on machine-sent mail; the address is then
  // the only thing there is to show.
  return { name: name || address, address }
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted = /^"(.*)"$/.exec(trimmed)
  return (quoted ? quoted[1] : trimmed).replace(/\\"/g, '"').trim()
}

function domainOf(address: string): string {
  return address.split('@').pop()?.toLowerCase().trim() ?? ''
}

function localPartOf(address: string): string {
  return address.split('@')[0]?.trim() ?? ''
}

/**
 * The label a domain is actually known by: `no-reply@email.claude.com` and
 * `support@claude.com` both reduce to `claude`.
 *
 * Deliberately not a public-suffix lookup — that needs a list which has to be
 * kept current, and being wrong here costs an avatar colour, not correctness.
 */
export function brandLabel(address: string): string {
  const labels = domainOf(address).split('.').filter(Boolean)
  if (labels.length === 0) return address.toLowerCase().trim()
  if (labels.length === 1) return labels[0]

  // Drop the TLD, then a registry second level like the `co` of `co.uk`.
  let remaining = labels.slice(0, -1)
  if (remaining.length > 1 && SUFFIX_LABELS.has(remaining[remaining.length - 1])) {
    remaining = remaining.slice(0, -1)
  }

  // Then the sending subdomains from the front — but never the last label,
  // since `news.com` is a brand that happens to be called "news".
  let start = 0
  while (start < remaining.length - 1 && SENDING_LABELS.has(remaining[start])) start += 1

  return remaining[remaining.length - 1] ?? labels[0]
}

/**
 * True when the domain's leading label is one a brand only ever sends from,
 * e.g. `news.meshy.ai` or `email.claude.com`. A mailbox at such a subdomain is
 * a bulk-mail rig rather than a person.
 */
export function hasSendingSubdomain(address: string): boolean {
  const labels = domainOf(address).split('.').filter(Boolean)
  return labels.length > 2 && SENDING_LABELS.has(labels[0])
}

/**
 * What a sender's identity is keyed on: the brand for a company, the whole
 * address for a person at a consumer mailbox.
 */
export function identityKey(address: string): string {
  const normalized = address.toLowerCase().trim()
  return CONSUMER_DOMAINS.has(domainOf(normalized)) ? normalized : brandLabel(normalized)
}

/**
 * The five avatar tones, drawn only from the logo ramp plus the two status
 * hues. A fixed, small set is the point: a hash over the full colour wheel
 * would give every correspondent an arbitrary colour and the list would read
 * as a rainbow rather than as one system.
 */
export type SenderTone = 'blue' | 'cyan' | 'violet' | 'green' | 'warn'

const TONES: SenderTone[] = ['blue', 'cyan', 'violet', 'green', 'warn']

export function senderTone(address: string): SenderTone {
  const key = identityKey(address)
  // FNV-1a: cheap, and stable across runs and platforms in a way that a
  // hand-rolled sum of char codes is not.
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return TONES[hash % TONES.length]
}

const FIRST_ALPHANUMERIC = /\p{L}|\p{N}/u

/**
 * The monogram. Taken from the display name when there is one, and from the
 * identity otherwise — so `Claude Team` and a bare
 * `no-reply@email.claude.com` both show a C.
 */
export function senderInitial(sender: Sender): string {
  // A "name" that is really just the address tells us nothing a machine-sent
  // local part like `no-reply` wouldn't ruin.
  const displayName = sender.name.includes('@') ? '' : sender.name
  const fromName = FIRST_ALPHANUMERIC.exec(displayName)
  if (fromName) return fromName[0].toUpperCase()

  const key = CONSUMER_DOMAINS.has(domainOf(sender.address))
    ? localPartOf(sender.address)
    : brandLabel(sender.address)
  const fromKey = FIRST_ALPHANUMERIC.exec(key)
  return fromKey ? fromKey[0].toUpperCase() : '?'
}

/** How much snippet a row can show before it is just filling the line. */
const SNIPPET_LIMIT = 160

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
}

/**
 * Turns a provider snippet into one readable line.
 *
 * Providers hand back the first N characters of the message with no regard for
 * what those characters are, so a mail whose body opens with a stylesheet
 * yields a snippet that is literally `96 * { box-sizing: border-box; } body {
 * margin: 0 }`. Marketing mail is nearly as bad: invisible padding characters,
 * tracking URLs longer than the sentence around them, and a rule of dashes at
 * the end.
 */
export function cleanSnippet(raw: string): string {
  if (!raw) return ''

  let text = raw
    // Whole elements whose content is code rather than prose.
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')

  text = decodeEntities(text)

  return truncate(
    text
      // CSS that survived because the snippet was cut out of the middle of a
      // stylesheet and so never had an opening tag to strip.
      .replace(/[^{}]*\{[^{}]*\}/g, ' ')
      // A block the cut left unclosed, e.g. `#MessageViewBody a { color: inh`.
      .replace(/[^{}]*\{[^{}]*$/, ' ')
      // Tracking URLs. A truncated URL is never worth the room it takes, and a
      // whole one is rarely what a reader wanted from a preview line.
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
      // The zero-width padding bulk senders use to defeat preview de-duping:
      // soft hyphen, the ZWSP/ZWNJ/ZWJ/bidi-mark block, word joiner, BOM.
      .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
      // Bracket pairs and separators left holding nothing after the above.
      .replace(/\(\s*\)|\[\s*\]|<\s*>/g, ' ')
      .replace(/\s+/g, ' ')
      // Rules of dashes, equals or bullets, at either end.
      .replace(/^[-=_·•|\s]+/, '')
      .replace(/[-=_·•|\s]+$/, '')
      .trim(),
    SNIPPET_LIMIT
  )
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (!body.startsWith('#')) return ENTITIES[body.toLowerCase()] ?? whole
    const code =
      body[1]?.toLowerCase() === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
  })
}

/** Cuts at a sentence end where there is one nearby, and a word break otherwise. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const window = text.slice(0, limit)
  const sentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? ')
  )
  if (sentence >= limit * 0.5) return window.slice(0, sentence + 1)
  const word = window.lastIndexOf(' ')
  return `${(word > 0 ? window.slice(0, word) : window).replace(/[,;:\s]+$/, '')}…`
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A date a reader can take in without parsing it.
 *
 * `7/24/2026` on every row is eleven characters saying almost nothing; what a
 * reader wants from an inbox is how old this is relative to now, at whatever
 * resolution still tells it apart from the rows either side.
 */
export function formatThreadDate(timestamp: number, now = Date.now(), locale?: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date(now)

  if (startOfDay(date) === startOfDay(today)) {
    return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  }
  // Compared on calendar days rather than elapsed milliseconds, so something
  // sent late on Monday still reads as "Mon" on Tuesday morning.
  const daysApart = Math.round((startOfDay(today) - startOfDay(date)) / DAY_MS)
  if (daysApart > 0 && daysApart < 7) {
    return date.toLocaleDateString(locale, { weekday: 'short' })
  }
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString(locale, { month: 'short', year: 'numeric' })
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}
