import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount } from '@shared/email.types'

/**
 * Operations that move real mail, against a fake IMAP server.
 *
 * These are the paths where getting the target set wrong is destructive rather
 * than cosmetic: what archiving relocates, whether un-archiving can find
 * anything at all, and whether a sent message is filed where the thread view
 * will look for it.
 */

const imap = vi.hoisted(() => ({
  mailboxes: [] as Array<{ path: string; specialUse?: string }>,
  messages: new Map<string, Array<{ uid: number; subject: string; messageId: string }>>(),
  appended: [] as Array<{ mailbox: string; raw: string; flags: string[] }>,
  moves: [] as Array<{ from: string; uids: string; to: string }>,
  /** Stands in for a server (Gmail) that files its own copy of a sent message. */
  sentAlreadyHasEveryMessageId: false,
  failAppend: false
}))

const smtpSends = vi.hoisted(() => [] as Array<Record<string, unknown>>)

function rfc822(message: { subject: string; messageId: string }): string {
  return [
    `Subject: ${message.subject}`,
    'From: someone@example.com',
    `Message-ID: ${message.messageId}`,
    'Date: Wed, 02 Aug 2026 10:00:00 +0000',
    '',
    'Body text.'
  ].join('\r\n')
}

vi.mock('imapflow', () => {
  class FakeImapFlow {
    usable = true
    private current = ''
    on(): void {}
    connect(): Promise<void> {
      return Promise.resolve()
    }
    logout(): Promise<void> {
      return Promise.resolve()
    }
    close(): void {}
    list(): Promise<Array<{ path: string; specialUse?: string }>> {
      return Promise.resolve(imap.mailboxes)
    }
    getMailboxLock(path: string): Promise<{ release: () => void }> {
      this.current = path
      return Promise.resolve({ release: () => {} })
    }
    search(query: Record<string, never>): Promise<number[]> {
      const held = imap.messages.get(this.current) ?? []
      const header = (query as { header?: Record<string, string> }).header
      if (header?.['message-id']) {
        if (imap.sentAlreadyHasEveryMessageId) return Promise.resolve([99])
        return Promise.resolve(
          held.filter((m) => m.messageId === header['message-id']).map((m) => m.uid)
        )
      }
      if (header?.subject !== undefined) {
        // IMAP SEARCH HEADER is a substring test — modelled faithfully, since
        // that is precisely what made an empty subject match everything.
        return Promise.resolve(
          held.filter((m) => m.subject.includes(header.subject)).map((m) => m.uid)
        )
      }
      return Promise.resolve(held.map((m) => m.uid))
    }
    async *fetch(range: string): AsyncGenerator<unknown> {
      const wanted = new Set(range.split(',').map(Number))
      for (const message of imap.messages.get(this.current) ?? []) {
        if (!wanted.has(message.uid)) continue
        yield await Promise.resolve({
          uid: message.uid,
          flags: new Set<string>(),
          source: Buffer.from(rfc822(message), 'utf-8')
        })
      }
    }
    append(mailbox: string, raw: Buffer, flags: string[]): Promise<void> {
      if (imap.failAppend) return Promise.reject(new Error('append refused'))
      imap.appended.push({ mailbox, raw: raw.toString('utf-8'), flags })
      return Promise.resolve()
    }
    messageMove(selector: { uid: string }, destination: string): Promise<void> {
      imap.moves.push({ from: this.current, uids: selector.uid, to: destination })
      return Promise.resolve()
    }
  }
  return { ImapFlow: FakeImapFlow }
})

vi.mock('nodemailer', () => ({
  createTransport: (options: { streamTransport?: boolean }) => ({
    sendMail: (mail: Record<string, unknown>) => {
      if (options.streamTransport) {
        return Promise.resolve({ message: Buffer.from(`RAW ${String(mail.messageId)}`, 'utf-8') })
      }
      smtpSends.push(mail)
      return Promise.resolve({ messageId: mail.messageId })
    },
    close: () => {}
  })
}))

vi.mock('../../EmailAuthStore', () => ({
  emailAuthStore: { getPassword: () => 'app-password' }
}))

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const { ImapSmtpAdapter, encodeThreadId } = await import('../ImapSmtpAdapter')

const SENT = '[Gmail]/Sent Mail'

const account: EmailAccount = {
  id: 'acct-1',
  provider: 'imap',
  address: 'me@example.com',
  displayName: 'Me',
  authKind: 'password',
  syncMode: 'full',
  imap: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me@example.com' },
  smtp: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'me@example.com' },
  createdAt: 1
}

let adapter: InstanceType<typeof ImapSmtpAdapter>

beforeEach(() => {
  imap.mailboxes = [
    { path: 'INBOX' },
    { path: SENT, specialUse: '\\Sent' },
    { path: 'Archive', specialUse: '\\Archive' }
  ]
  imap.messages = new Map()
  imap.appended = []
  imap.moves = []
  imap.sentAlreadyHasEveryMessageId = false
  imap.failAppend = false
  smtpSends.length = 0
  adapter = new ImapSmtpAdapter()
})

describe('archiving a conversation', () => {
  it('moves the inbox copy and leaves the account’s own replies in Sent', async () => {
    imap.messages.set('INBOX', [
      { uid: 1, subject: 'Quarterly report', messageId: '<a@example.com>' }
    ])
    imap.messages.set(SENT, [
      { uid: 7, subject: 'Re: Quarterly report', messageId: '<b@example.com>' }
    ])

    await adapter.applyFlag(account, {
      threadId: encodeThreadId('Quarterly report', 'INBOX', 1),
      action: 'archive'
    })

    // A thread resolves to both halves so the reader sees the whole exchange;
    // relocating the Sent half would quietly empty the user's Sent folder.
    expect(imap.moves).toEqual([{ from: 'INBOX', uids: '1', to: 'Archive' }])
  })
})

describe('un-archiving a conversation', () => {
  it('finds the thread where archiving left it', async () => {
    imap.messages.set('Archive', [
      { uid: 3, subject: 'Quarterly report', messageId: '<a@example.com>' }
    ])

    await adapter.applyFlag(account, {
      threadId: encodeThreadId('Quarterly report', 'INBOX', 1),
      action: 'unarchive'
    })

    // Resolving against the default INBOX + Sent found nothing, so this used to
    // throw "That conversation has no messages" — unarchive could never undo an
    // archive.
    expect(imap.moves).toEqual([{ from: 'Archive', uids: '3', to: 'INBOX' }])
  })
})

describe('sending', () => {
  const outgoing = {
    to: ['them@example.com'],
    cc: [],
    bcc: [],
    subject: 'Quarterly report',
    body: 'Here it is.',
    attachments: []
  }

  it('files a copy in Sent, flagged as read', async () => {
    await adapter.send(account, outgoing)

    expect(smtpSends).toHaveLength(1)
    expect(imap.appended).toHaveLength(1)
    expect(imap.appended[0].mailbox).toBe(SENT)
    expect(imap.appended[0].flags).toEqual(['\\Seen'])
  })

  it('gives the filed copy the same Message-ID that was delivered', async () => {
    await adapter.send(account, outgoing)

    // Threading and the duplicate check below both key on this header.
    const delivered = String(smtpSends[0].messageId)
    expect(delivered).toMatch(/^<.+@example\.com>$/)
    expect(imap.appended[0].raw).toContain(delivered)
  })

  it('does not file a second copy when the server already filed its own', async () => {
    imap.sentAlreadyHasEveryMessageId = true

    await adapter.send(account, outgoing)

    expect(smtpSends).toHaveLength(1)
    expect(imap.appended).toHaveLength(0)
  })

  it('reports success when the message went out but could not be filed', async () => {
    imap.failAppend = true

    // The mail is already delivered by the time filing runs, so a filing
    // failure must never surface as a failed send.
    await expect(adapter.send(account, outgoing)).resolves.toBeUndefined()
    expect(smtpSends).toHaveLength(1)
  })
})
