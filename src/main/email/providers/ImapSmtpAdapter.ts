import { ImapFlow, type FetchMessageObject, type MailboxLockObject } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { createTransport } from 'nodemailer'
import type {
  EmailAccount,
  EmailAttachmentSummary,
  EmailEndpoint,
  EmailMailbox,
  EmailMessage,
  EmailThreadSummary
} from '@shared/email.types'
import type {
  EmailAttachmentContent,
  EmailIdentity,
  EmailProviderAdapter,
  FlagTarget,
  ListThreadsOptions,
  MoveTarget
} from './types'
import type { OutgoingMessage } from '../mime'
import { htmlToPlainText } from '../mime'
import { sanitizeEmailHtml, type InlineImage } from '../htmlBody'
import { emailAuthStore } from '../EmailAuthStore'
import { createLogger } from '../../utils/logger'

const log = createLogger('email:imap')

/** How many recent messages a thread grouping pass looks at. */
const THREAD_WINDOW = 60

/** Enough leading bytes to clear MIME headers and reach real body text. */
const SNIPPET_SOURCE_BYTES = 8 * 1024

/** Preview length, matching roughly what Gmail's own `snippet` returns. */
const SNIPPET_CHARS = 200

/**
 * How long an unused connection stays open. Long enough to cover a burst of UI
 * actions, short enough that Anodex isn't holding an idle IMAP session for the
 * whole time the app is running.
 */
const IDLE_CONNECTION_MS = 60_000

/**
 * Generic IMAP + SMTP, covering every provider without a first-class API:
 * iCloud, Yahoo, Fastmail, Proton Bridge, corporate Exchange over IMAP, and
 * self-hosted servers. Most of them require an app-specific password rather
 * than the account password, which the linking UI explains per provider.
 *
 * IMAP has no server-side notion of a conversation, so threads are derived:
 * messages are grouped by normalized subject, and a thread id encodes that
 * subject so it can be re-resolved with a server-side SEARCH instead of being
 * held in memory between calls.
 */
/** A connection held open between operations, with a count of active users. */
interface PooledConnection {
  client: ImapFlow
  inUse: number
  idleTimer?: NodeJS.Timeout
}

export class ImapSmtpAdapter implements EmailProviderAdapter {
  readonly provider = 'imap' as const

  /**
   * Live connections by account id, stored as the in-flight promise so
   * simultaneous callers share one connect rather than racing to open two.
   */
  private connections = new Map<string, Promise<PooledConnection>>()

  async verify(account: EmailAccount): Promise<EmailIdentity> {
    // Selecting INBOX is the cheapest proof that the credentials work and the
    // server is reachable; IMAP has no profile endpoint to ask for an address,
    // so the one the user typed is the only one there is.
    await this.withMailbox(account, 'INBOX', () => Promise.resolve(undefined))
    return { address: account.address, displayName: account.displayName }
  }

  async listThreads(
    account: EmailAccount,
    options: ListThreadsOptions
  ): Promise<EmailThreadSummary[]> {
    const mailbox = options.mailbox ?? 'INBOX'
    return this.withMailbox(account, mailbox, async (client) => {
      const uids = options.query
        ? await client.search({ or: searchTerms(options.query) }, { uid: true })
        : await client.search({ all: true }, { uid: true })
      if (!uids || uids.length === 0) return []

      // Newest first, then take a window large enough that grouping has
      // something to group before the limit is applied.
      const window = uids.slice(-Math.max(options.limit, THREAD_WINDOW)).reverse()
      const messages: EmailMessage[] = []
      for await (const raw of client.fetch(
        window.join(','),
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true }
      )) {
        messages.push(fromEnvelope(raw, account, mailbox))
      }

      const threads = groupIntoThreads(messages, account, options.limit)
      await this.attachSnippets(client, threads, mailbox)
      return threads
    })
  }

  /**
   * Fills in preview text for the threads actually being returned.
   *
   * IMAP envelopes carry no equivalent of Gmail's `snippet`, so the listing
   * would otherwise show a subject and sender with no preview at all. Bodies
   * are fetched only for the handful of threads that survived the limit, and
   * only the first few KB of each, in a single batched round-trip — fetching
   * full sources for the whole grouping window would be an order of magnitude
   * more data for text that is immediately truncated.
   */
  private async attachSnippets(
    client: ImapFlow,
    threads: EmailThreadSummary[],
    mailbox: string
  ): Promise<void> {
    if (threads.length === 0) return

    const byUid = new Map<number, EmailThreadSummary>()
    for (const thread of threads) {
      try {
        byUid.set(parseMessageId(thread.latestMessageId).uid, thread)
      } catch {
        // A thread whose id can't be parsed simply goes without a preview.
      }
    }
    if (byUid.size === 0) return

    try {
      for await (const raw of client.fetch(
        [...byUid.keys()].join(','),
        { uid: true, source: { start: 0, maxLength: SNIPPET_SOURCE_BYTES } },
        { uid: true }
      )) {
        const thread = byUid.get(raw.uid)
        if (!thread || !raw.source) continue
        // A truncated source is not a complete MIME document; mailparser
        // tolerates that and returns whatever it could read, which is all a
        // preview needs.
        const parsed = await simpleParser(raw.source)
        const text = parsed.text?.trim() || (parsed.html ? htmlToPlainText(parsed.html) : '')
        thread.snippet = text.replace(/\s+/g, ' ').slice(0, SNIPPET_CHARS).trim()
      }
    } catch (error) {
      // Previews are cosmetic — a server that refuses partial fetches must not
      // take the whole inbox listing down with it.
      log.warn(`Could not build previews for ${mailbox}:`, error)
    }
  }

  /**
   * Every message in the conversation — including the ones the account sent.
   *
   * This used to read INBOX alone, which meant a thread only ever contained
   * the other party's half of it. On screen that is worse than incomplete: a
   * back-and-forth renders as one person talking, with the reader's own
   * replies visible only as quoted text inside the answers to them.
   *
   * IMAP has no thread primitive, so a conversation is a subject match, and
   * the account's own replies live in the server's Sent folder rather than the
   * inbox. Both are searched and the results merged.
   */
  async getThreadMessages(account: EmailAccount, threadId: string): Promise<EmailMessage[]> {
    const subject = decodeThreadId(threadId)
    const mailboxes = ['INBOX', ...(await this.findSentMailbox(account))]

    const collected: EmailMessage[] = []
    for (const mailbox of mailboxes) {
      // One unreadable folder must not cost the reader the whole thread — the
      // inbox half is still worth showing.
      try {
        collected.push(...(await this.searchMailboxBySubject(account, mailbox, subject)))
      } catch (error) {
        log.warn(`Could not read ${mailbox} for thread "${subject}":`, error)
      }
    }

    // A server may file one message in both folders — Gmail does for anything
    // sent to yourself. The RFC 5322 Message-ID is what says they are the
    // same message; without one, the mailbox-scoped id is the best available.
    const seen = new Set<string>()
    return collected
      .filter((message) => {
        const key = message.messageIdHeader ?? message.id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((left, right) => left.date - right.date)
  }

  private async searchMailboxBySubject(
    account: EmailAccount,
    mailbox: string,
    subject: string
  ): Promise<EmailMessage[]> {
    return this.withMailbox(account, mailbox, async (client) => {
      const uids = await client.search({ header: { subject } }, { uid: true })
      if (!uids || uids.length === 0) return []

      const messages: EmailMessage[] = []
      for await (const raw of client.fetch(
        uids.slice(-THREAD_WINDOW).join(','),
        { uid: true, envelope: true, flags: true, source: true },
        { uid: true }
      )) {
        messages.push(await fromSource(raw, account, mailbox))
      }
      return messages
    })
  }

  /**
   * The server's Sent folder, as a zero- or one-element list so the caller can
   * spread it. Empty when the server advertises none: a missing Sent folder
   * makes a thread one-sided, which is how it behaved before, and is not worth
   * failing the read over.
   *
   * `\Sent` is checked before the name for the same reason as the archive
   * lookup below — Gmail over IMAP calls it "[Gmail]/Sent Mail", which no
   * literal-name match would find.
   */
  private async findSentMailbox(account: EmailAccount): Promise<string[]> {
    try {
      return await this.withClient(account, async (client) => {
        const mailboxes = await client.list()
        const path =
          mailboxes.find((mailbox) => mailbox.specialUse === '\\Sent')?.path ??
          mailboxes.find((mailbox) =>
            /^(?:\[gmail\]\/)?sent(?:\s?mail| items)?$/i.test(mailbox.path)
          )?.path
        return path ? [path] : []
      })
    } catch (error) {
      log.warn(`Could not list mailboxes for ${account.address}:`, error)
      return []
    }
  }

  async readMessage(account: EmailAccount, messageId: string): Promise<EmailMessage> {
    const { mailbox, uid } = parseMessageId(messageId)
    return this.withMailbox(account, mailbox, async (client) => {
      const raw = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true, source: true },
        { uid: true }
      )
      // `fetchOne` resolves to `false` rather than throwing when the UID is gone.
      if (!raw) throw new Error(`Message ${messageId} was not found in ${mailbox}.`)
      return fromSource(raw, account, mailbox)
    })
  }

  async getUnreadThreadCount(account: EmailAccount): Promise<number> {
    return this.withClient(account, async (client) => {
      const status = await client.status('INBOX', { unseen: true })
      return Math.max(0, Math.floor(Number(status.unseen ?? 0)))
    })
  }

  async getAttachment(
    account: EmailAccount,
    messageId: string,
    attachmentId: string
  ): Promise<EmailAttachmentContent> {
    const message = await this.readMessageWithParsed(account, messageId)
    const attachment = message.parsed.attachments.find(
      (candidate, index) => attachmentKey(candidate, index) === attachmentId
    )
    if (!attachment) throw new Error('Attachment was not found on that message.')
    return {
      id: attachmentId,
      messageId,
      filename: attachment.filename ?? 'attachment',
      mimeType: attachment.contentType ?? 'application/octet-stream',
      size: attachment.size ?? attachment.content.length,
      data: Buffer.from(attachment.content)
    }
  }

  async send(account: EmailAccount, message: OutgoingMessage): Promise<void> {
    const smtp = requireEndpoint(account.smtp, account, 'SMTP')
    const password = requirePassword(account)

    const transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.security === 'tls',
      requireTLS: smtp.security === 'starttls',
      auth: { user: smtp.username, pass: password }
    })

    try {
      await transport.sendMail({
        from: account.displayName ? `${account.displayName} <${account.address}>` : account.address,
        to: message.to,
        cc: message.cc.length ? message.cc : undefined,
        bcc: message.bcc.length ? message.bcc : undefined,
        subject: message.subject,
        text: message.body,
        inReplyTo: message.inReplyTo,
        references: message.references?.length ? message.references : undefined,
        attachments: message.attachments.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.mimeType,
          content: Buffer.from(attachment.contentBase64, 'base64')
        }))
      })
    } finally {
      transport.close()
    }
  }

  async applyFlag(account: EmailAccount, target: FlagTarget): Promise<string> {
    if (target.action === 'archive' || target.action === 'unarchive') {
      const destination =
        target.action === 'archive' ? await this.findArchiveMailbox(account) : 'INBOX'
      return this.move(account, { ...target, mailbox: destination })
    }

    const targets = await this.resolveTargets(account, target)
    const flags = IMAP_FLAGS[target.action]
    for (const [mailbox, uids] of targets) {
      await this.withMailbox(account, mailbox, async (client) => {
        const selector = { uid: uids.join(',') }
        if (flags.add.length) await client.messageFlagsAdd(selector, flags.add, { uid: true })
        if (flags.remove.length)
          await client.messageFlagsRemove(selector, flags.remove, { uid: true })
      })
    }
    return FLAG_DESCRIPTIONS[target.action]
  }

  async move(account: EmailAccount, target: MoveTarget): Promise<string> {
    const destination = await this.resolveMailboxPath(account, target.mailbox)
    const targets = await this.resolveTargets(account, target)
    let moved = 0
    for (const [mailbox, uids] of targets) {
      if (mailbox === destination) continue
      await this.withMailbox(account, mailbox, async (client) => {
        await client.messageMove({ uid: uids.join(',') }, destination, { uid: true })
      })
      moved += uids.length
    }
    return `Moved ${moved} message${moved === 1 ? '' : 's'} to ${destination}`
  }

  /**
   * Finds where "archive" should put a message on this particular server.
   *
   * There is no universal archive folder. RFC 6154 servers advertise `\Archive`
   * (Fastmail, iCloud), but Gmail has no such folder at all — its archive is
   * "[Gmail]/All Mail", advertised as `\All`, and moving out of INBOX is
   * exactly what archiving means there. Matching on the literal name "Archive"
   * therefore fails on Gmail, which is most of the accounts that reach this
   * adapter, so the special-use attributes are checked first and the name is
   * only a last resort.
   */
  private async findArchiveMailbox(account: EmailAccount): Promise<string> {
    return this.withClient(account, async (client) => {
      const mailboxes = await client.list()
      const bySpecialUse = (use: string): string | undefined =>
        mailboxes.find((mailbox) => mailbox.specialUse === use)?.path

      const path =
        bySpecialUse('\\Archive') ??
        bySpecialUse('\\All') ??
        mailboxes.find((mailbox) => mailbox.path.toLowerCase() === 'archive')?.path
      if (!path) {
        throw new Error(
          `${account.address} has no archive folder. Available: ${mailboxes
            .map((mailbox) => mailbox.path)
            .join(', ')}`
        )
      }
      return path
    })
  }

  async listMailboxes(account: EmailAccount): Promise<EmailMailbox[]> {
    return this.withClient(account, async (client) => {
      const list = await client.list()
      return list.map((mailbox) => ({
        id: mailbox.path,
        name: mailbox.path,
        // `specialUse` marks server-designated folders (\Sent, \Archive, …).
        system: Boolean(mailbox.specialUse) || mailbox.path.toUpperCase() === 'INBOX'
      }))
    })
  }

  /** Maps a flag/move target onto the `{ mailbox -> uids }` pairs it touches. */
  private async resolveTargets(
    account: EmailAccount,
    target: { threadId?: string; messageId?: string }
  ): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>()

    if (target.messageId?.trim()) {
      const { mailbox, uid } = parseMessageId(target.messageId.trim())
      result.set(mailbox, [uid])
      return result
    }
    if (!target.threadId?.trim()) throw new Error('A thread id or message id is required.')

    for (const message of await this.getThreadMessages(account, target.threadId.trim())) {
      const { mailbox, uid } = parseMessageId(message.id)
      const existing = result.get(mailbox)
      if (existing) existing.push(uid)
      else result.set(mailbox, [uid])
    }
    if (result.size === 0) throw new Error('That conversation has no messages.')
    return result
  }

  private async resolveMailboxPath(account: EmailAccount, mailbox: string): Promise<string> {
    const wanted = mailbox.trim()
    if (!wanted) throw new Error('A mailbox name is required.')
    const mailboxes = await this.listMailboxes(account)
    const match = mailboxes.find(
      (candidate) => candidate.name.toLowerCase() === wanted.toLowerCase()
    )
    if (match) return match.name

    // Servers namespace folders differently ('Archive' vs 'INBOX.Archive'), so
    // fall back to a suffix match before giving up.
    const suffix = mailboxes.find((candidate) =>
      candidate.name.toLowerCase().endsWith(`.${wanted.toLowerCase()}`)
    )
    if (suffix) return suffix.name
    throw new Error(
      `No IMAP folder named "${mailbox}". Available: ${mailboxes.map((m) => m.name).join(', ')}`
    )
  }

  private async readMessageWithParsed(
    account: EmailAccount,
    messageId: string
  ): Promise<{ parsed: ParsedMail }> {
    const { mailbox, uid } = parseMessageId(messageId)
    return this.withMailbox(account, mailbox, async (client) => {
      const raw = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
      if (raw === false || !raw.source) {
        throw new Error(`Message ${messageId} was not found in ${mailbox}.`)
      }
      return { parsed: await simpleParser(raw.source) }
    })
  }

  private async withMailbox<T>(
    account: EmailAccount,
    mailbox: string,
    run: (client: ImapFlow) => Promise<T>
  ): Promise<T> {
    return this.withClient(account, async (client) => {
      let lock: MailboxLockObject | undefined
      try {
        lock = await client.getMailboxLock(mailbox)
        return await run(client)
      } finally {
        lock?.release()
      }
    })
  }

  /**
   * Runs an operation on a live connection, reusing one where possible.
   *
   * A connect + TLS handshake + LOGIN costs several round-trips, and the UI
   * fires operations in quick succession — marking a thread read then reloading
   * the list used to mean three full handshakes. Connections are therefore kept
   * open briefly between operations and closed once idle.
   *
   * Reuse is only ever an optimisation: a pooled connection that died silently
   * (IMAP sockets are routinely dropped by NAT and server idle timers) is
   * detected and replaced, and the operation is retried once on a fresh one, so
   * a stale socket surfaces as a slower call rather than an error.
   */
  private async withClient<T>(
    account: EmailAccount,
    run: (client: ImapFlow) => Promise<T>
  ): Promise<T> {
    // Each attempt owns exactly one acquire/release pair. A genuine command
    // failure propagates immediately; only a lost connection comes back as
    // `lost`, and only that is worth a second try.
    const attempt = async (): Promise<{ value: T } | { lost: true; error: unknown }> => {
      const connection = await this.acquire(account)
      try {
        return { value: await run(connection.client) }
      } catch (error) {
        if (!isConnectionLost(error, connection.client)) throw error
        this.discard(account.id, connection.client)
        return { lost: true, error }
      } finally {
        this.release(account.id)
      }
    }

    const first = await attempt()
    if ('value' in first) return first.value

    log.info(`IMAP connection for ${account.address} was dropped; reconnecting.`)
    const second = await attempt()
    if ('value' in second) return second.value
    throw second.error
  }

  /** Returns a connected client for the account, opening one if needed. */
  private async acquire(account: EmailAccount): Promise<PooledConnection> {
    const existing = this.connections.get(account.id)
    if (existing) {
      // Two operations can arrive while the first connect is still in flight;
      // both await the same promise rather than opening a second socket.
      const connection = await existing
      if (connection.client.usable) {
        connection.inUse += 1
        if (connection.idleTimer) {
          clearTimeout(connection.idleTimer)
          connection.idleTimer = undefined
        }
        return connection
      }
      this.connections.delete(account.id)
    }

    const pending = this.connect(account)
    this.connections.set(account.id, pending)
    try {
      const connection = await pending
      connection.inUse += 1
      return connection
    } catch (error) {
      // A failed connect must not poison the pool for the next attempt.
      this.connections.delete(account.id)
      throw error
    }
  }

  private async connect(account: EmailAccount): Promise<PooledConnection> {
    const imap = requireEndpoint(account.imap, account, 'IMAP')
    const password = requirePassword(account)

    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.security === 'tls',
      auth: { user: imap.username, pass: password },
      logger: false,
      emitLogs: false
    })
    // ImapFlow emits 'error' on the client itself; without a listener an
    // unexpected socket drop becomes an unhandled 'error' event and takes the
    // main process down rather than failing this one call.
    client.on('error', (error) => log.warn(`IMAP error for ${account.address}:`, error))
    client.on('close', () => this.discard(account.id, client))

    await client.connect()
    return { client, inUse: 0, idleTimer: undefined }
  }

  /** Marks an operation finished and starts the idle countdown when none remain. */
  private release(accountId: string): void {
    const pending = this.connections.get(accountId)
    if (!pending) return

    void pending
      .then((connection) => {
        connection.inUse = Math.max(0, connection.inUse - 1)
        if (connection.inUse > 0 || connection.idleTimer) return

        connection.idleTimer = setTimeout(() => {
          this.connections.delete(accountId)
          void connection.client.logout().catch(() => connection.client.close())
        }, IDLE_CONNECTION_MS)
        // A pending logout must never hold the process open at quit.
        connection.idleTimer.unref?.()
      })
      .catch(() => {
        // The connect itself failed; `acquire` has already cleared the entry.
      })
  }

  /** Closes the pooled connection for an account being unlinked. */
  disconnect(accountId: string): void {
    this.discard(accountId)
  }

  /** Forgets a pooled connection, optionally only if it is the one given. */
  private discard(accountId: string, only?: ImapFlow): void {
    const pending = this.connections.get(accountId)
    if (!pending) return

    void pending
      .then((connection) => {
        if (only && connection.client !== only) return
        if (connection.idleTimer) clearTimeout(connection.idleTimer)
        this.connections.delete(accountId)
        connection.client.close()
      })
      .catch(() => {
        this.connections.delete(accountId)
      })
  }
}

const IMAP_FLAGS: Record<string, { add: string[]; remove: string[] }> = {
  mark_read: { add: ['\\Seen'], remove: [] },
  mark_unread: { add: [], remove: ['\\Seen'] },
  star: { add: ['\\Flagged'], remove: [] },
  unstar: { add: [], remove: ['\\Flagged'] }
}

const FLAG_DESCRIPTIONS: Record<FlagTarget['action'], string> = {
  mark_read: 'Marked as read',
  mark_unread: 'Marked as unread',
  star: 'Flagged',
  unstar: 'Cleared the flag',
  archive: 'Moved to Archive',
  unarchive: 'Moved back to the inbox'
}

/**
 * Distinguishes "the socket went away" from a genuine command failure, so only
 * the former triggers a reconnect-and-retry. Retrying a real error (a bad
 * mailbox name, a rejected move) would just repeat it against a new connection.
 */
function isConnectionLost(error: unknown, client: ImapFlow): boolean {
  if (!client.usable) return true
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return (
    message.includes('connection not available') ||
    message.includes('connection closed') ||
    message.includes('socket') ||
    message.includes('econnreset') ||
    message.includes('epipe') ||
    message.includes('etimedout')
  )
}

function requireEndpoint(
  endpoint: EmailEndpoint | undefined,
  account: EmailAccount,
  label: string
): EmailEndpoint {
  if (!endpoint) {
    throw new Error(`${account.address} has no ${label} server configured. Re-link it in Settings.`)
  }
  return endpoint
}

function requirePassword(account: EmailAccount): string {
  const password = emailAuthStore.getPassword(account.id)
  if (!password) {
    throw new Error(
      `No stored password for ${account.address}. Re-link the account in Settings -> Email.`
    )
  }
  return password
}

/**
 * IMAP UIDs are only unique within a mailbox, so the mailbox travels with the
 * id. Everything downstream — tools, the renderer — treats this as opaque.
 */
function encodeMessageId(mailbox: string, uid: number): string {
  return `${Buffer.from(mailbox, 'utf-8').toString('base64url')}.${uid}`
}

function parseMessageId(messageId: string): { mailbox: string; uid: number } {
  const separator = messageId.lastIndexOf('.')
  const uid = Number(messageId.slice(separator + 1))
  if (separator <= 0 || !Number.isInteger(uid) || uid <= 0) {
    throw new Error(`"${messageId}" is not a valid IMAP message id.`)
  }
  return {
    mailbox: Buffer.from(messageId.slice(0, separator), 'base64url').toString('utf-8'),
    uid
  }
}

function encodeThreadId(subject: string): string {
  return `subj.${Buffer.from(normalizeSubject(subject), 'utf-8').toString('base64url')}`
}

function decodeThreadId(threadId: string): string {
  if (!threadId.startsWith('subj.')) {
    throw new Error(`"${threadId}" is not a valid IMAP thread id.`)
  }
  return Buffer.from(threadId.slice('subj.'.length), 'base64url').toString('utf-8')
}

/** Strips reply/forward prefixes so a back-and-forth groups as one thread. */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*(re|fwd?|aw|sv)\s*:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function fromEnvelope(
  raw: FetchMessageObject,
  account: EmailAccount,
  mailbox: string
): EmailMessage {
  const envelope = raw.envelope
  const subject = envelope?.subject ?? ''
  return {
    id: encodeMessageId(mailbox, raw.uid),
    threadId: encodeThreadId(subject),
    provider: 'imap',
    accountId: account.id,
    subject: subject.trim() || '(no subject)',
    from: formatAddresses(envelope?.from)[0] ?? 'Unknown sender',
    to: formatAddresses(envelope?.to),
    cc: formatAddresses(envelope?.cc),
    bcc: formatAddresses(envelope?.bcc),
    date: envelope?.date ? new Date(envelope.date).getTime() : Date.now(),
    snippet: '',
    body: '',
    attachments: [],
    unread: isUnread(raw),
    messageIdHeader: envelope?.messageId,
    references: []
  }
}

/** IMAP marks read state with the `\Seen` system flag; absent means unread. */
function isUnread(raw: FetchMessageObject): boolean {
  return raw.flags ? !raw.flags.has('\\Seen') : false
}

async function fromSource(
  raw: FetchMessageObject,
  account: EmailAccount,
  mailbox: string
): Promise<EmailMessage> {
  if (!raw.source) return fromEnvelope(raw, account, mailbox)
  const parsed = await simpleParser(raw.source)
  const html = typeof parsed.html === 'string' ? parsed.html : ''
  const body = parsed.text?.trim() || (html ? htmlToPlainText(html) : '')
  const subject = parsed.subject ?? ''

  return {
    id: encodeMessageId(mailbox, raw.uid),
    threadId: encodeThreadId(subject),
    provider: 'imap',
    accountId: account.id,
    subject: subject.trim() || '(no subject)',
    from: parsed.from?.text?.trim() || 'Unknown sender',
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    bcc: addressText(parsed.bcc),
    date: parsed.date ? parsed.date.getTime() : Date.now(),
    snippet: body.slice(0, 200),
    body,
    // mailparser has already decoded every part, so the inline images are in
    // hand — no extra round-trip is needed to embed them.
    ...(html ? { bodyHtml: sanitizeEmailHtml(html, collectInlineImages(parsed)) } : {}),
    attachments: parsed.attachments.map((attachment, index) =>
      toAttachmentSummary(attachment, index, encodeMessageId(mailbox, raw.uid))
    ),
    unread: isUnread(raw),
    messageIdHeader: parsed.messageId,
    references: normalizeReferences(parsed.references)
  }
}

function toAttachmentSummary(
  attachment: ParsedMail['attachments'][number],
  index: number,
  messageId: string
): EmailAttachmentSummary {
  return {
    id: attachmentKey(attachment, index),
    messageId,
    filename: attachment.filename ?? `attachment-${index + 1}`,
    mimeType: attachment.contentType ?? 'application/octet-stream',
    size: attachment.size ?? attachment.content.length
  }
}

/**
 * Images the message carries for its own HTML to reference. Only parts with a
 * `Content-ID` qualify — a plain file attachment is listed separately rather
 * than being spliced into the body.
 */
function collectInlineImages(parsed: ParsedMail): InlineImage[] {
  return parsed.attachments
    .filter(
      (attachment) =>
        Boolean(attachment.contentId) && (attachment.contentType ?? '').startsWith('image/')
    )
    .map((attachment) => ({
      contentId: attachment.contentId as string,
      mimeType: attachment.contentType,
      data: Buffer.from(attachment.content)
    }))
}

/**
 * IMAP attachments have no server-side id, so one is derived. `contentId` is
 * used when present because it survives a re-fetch; the positional fallback
 * only has to be stable within a single message.
 */
function attachmentKey(attachment: ParsedMail['attachments'][number], index: number): string {
  return attachment.contentId?.replace(/[<>]/g, '') || `part-${index + 1}`
}

function normalizeReferences(references: string | string[] | undefined): string[] {
  if (!references) return []
  return Array.isArray(references) ? references : [references]
}

function addressText(value: ParsedMail['to']): string[] {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list.flatMap((entry) => entry.value.map(formatMailAddress)).filter(Boolean)
}

function formatMailAddress(entry: { name?: string; address?: string }): string {
  const address = entry.address?.trim()
  if (!address) return ''
  const name = entry.name?.trim()
  return name && name !== address ? `${name} <${address}>` : address
}

function formatAddresses(addresses: { name?: string; address?: string }[] | undefined): string[] {
  return (addresses ?? []).map(formatMailAddress).filter(Boolean)
}

/** IMAP SEARCH has no free-text mode, so a query fans out over common headers. */
function searchTerms(query: string): Record<string, unknown>[] {
  const trimmed = query.trim()
  return [
    { header: { subject: trimmed } },
    { header: { from: trimmed } },
    { header: { to: trimmed } },
    { body: trimmed }
  ]
}

function groupIntoThreads(
  messages: EmailMessage[],
  account: EmailAccount,
  limit: number
): EmailThreadSummary[] {
  const byThread = new Map<string, EmailMessage[]>()
  for (const message of messages) {
    const existing = byThread.get(message.threadId)
    if (existing) existing.push(message)
    else byThread.set(message.threadId, [message])
  }

  const summaries: EmailThreadSummary[] = []
  for (const [threadId, group] of byThread) {
    const sorted = [...group].sort((left, right) => right.date - left.date)
    const latest = sorted[0]
    summaries.push({
      id: threadId,
      latestMessageId: latest.id,
      provider: 'imap',
      accountId: account.id,
      subject: latest.subject,
      from: latest.from,
      snippet: latest.snippet,
      updatedAt: latest.date,
      unread: sorted.some((message) => message.unread === true),
      messageCount: sorted.length,
      attachmentCount: sorted.reduce((total, message) => total + message.attachments.length, 0)
    })
  }

  return summaries.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
}
