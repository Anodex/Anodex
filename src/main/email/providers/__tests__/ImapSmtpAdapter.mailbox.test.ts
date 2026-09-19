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
  /**
   * Stands in for a server whose search disagrees with us about punctuation.
   *
   * Gmail does. Two subjects ending in a question mark returned nothing at all
   * from a mailbox holding both, while subjects with apostrophes, commas and an
   * em dash in the same inbox came back — so those conversations could not be
   * opened from the computer or the phone, and neither screen said why.
   */
  refusesPunctuatedSearch: false,
  /**
   * Stands in for a server whose search disagrees with its own mailbox.
   *
   * Gmail does this too, and not only over punctuation: a message sitting in
   * the inbox it had just listed came back from `HEADER SUBJECT` as nothing at
   * all, for the whole subject and for a punctuation-free stretch of it alike.
   */
  subjectSearchFindsNothing: false,
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
        if (imap.subjectSearchFindsNothing) return Promise.resolve([])
        // A server within its rights to answer nothing for a term it does not
        // like. Nothing in IMAP promises otherwise, and Gmail takes it.
        if (imap.refusesPunctuatedSearch && /[^\p{L}\p{N}\s_-]/u.test(header.subject)) {
          return Promise.resolve([])
        }
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
          // A real server answers with the envelope when it is asked for, and
          // reading the mailbox by envelope is how a thread is found when the
          // server's own search will not find it.
          envelope: { subject: message.subject },
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
const TRASH = '[Gmail]/Trash'

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
    { path: 'Archive', specialUse: '\\Archive' },
    { path: TRASH, specialUse: '\\Trash' }
  ]
  imap.messages = new Map()
  imap.appended = []
  imap.moves = []
  imap.sentAlreadyHasEveryMessageId = false
  imap.refusesPunctuatedSearch = false
  imap.subjectSearchFindsNothing = false
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

/**
 * Opening a conversation, against a server that is fussy about the query.
 *
 * The failure this covers was silent from end to end: the provider returned no
 * messages, the thread was rendered empty, and the only words anywhere were
 * "this conversation has no readable messages" — which reads as a fact about the
 * mail rather than a failed read, so nobody looked. Two of five conversations in
 * a real inbox were unopenable for weeks.
 */
describe('opening a conversation', () => {
  const SUBJECT = '"Anyone else dealing with this?"'

  it('opens a thread whose subject the server will not search for', async () => {
    imap.refusesPunctuatedSearch = true
    imap.messages.set('INBOX', [{ uid: 1, subject: SUBJECT, messageId: '<a@example.com>' }])

    const messages = await adapter.getThreadMessages(account, encodeThreadId(SUBJECT, 'INBOX', 1))

    // Asking for the whole subject returned nothing here, which is the bug.
    expect(messages.map((message) => message.subject)).toEqual([SUBJECT])
  })

  it('still collects the replies, which carry a prefix', async () => {
    imap.refusesPunctuatedSearch = true
    imap.messages.set('INBOX', [
      { uid: 1, subject: SUBJECT, messageId: '<a@example.com>' },
      { uid: 2, subject: `Re: ${SUBJECT}`, messageId: '<b@example.com>' }
    ])

    const messages = await adapter.getThreadMessages(account, encodeThreadId(SUBJECT, 'INBOX', 1))

    expect(messages).toHaveLength(2)
  })

  it('does not widen the thread to whatever the looser query matched', async () => {
    // The term handed to the server is a substring, so it matches more than the
    // thread. That is only safe because the exact match happens on this side —
    // without it, loosening the query would quietly merge conversations, and
    // `applyFlag` and `move` act on whatever a thread resolves to.
    imap.messages.set('INBOX', [
      { uid: 1, subject: SUBJECT, messageId: '<a@example.com>' },
      {
        uid: 2,
        subject: `Fwd: ${SUBJECT} - my take`,
        messageId: '<c@example.com>'
      }
    ])

    const messages = await adapter.getThreadMessages(account, encodeThreadId(SUBJECT, 'INBOX', 1))

    expect(messages.map((message) => message.subject)).toEqual([SUBJECT])
  })

  it('keeps what the search found when nothing matches exactly', () => {
    // Two parsers read the subject: the listing decodes the envelope, the read
    // decodes the whole message. They agree today. If a message ever arrives
    // where they do not, an exact match that excludes everything would empty the
    // conversation — reintroducing the bug this all exists to fix, through the
    // fix for it. The loose set is what the caller received before any of this,
    // so falling back to it can be no worse.
    // The id says one thing, the message says another — which is what a
    // disagreement between the two decoders looks like from here.
    imap.messages.set('INBOX', [
      { uid: 1, subject: 'Quarterly report', messageId: '<a@example.com>' }
    ])

    return adapter
      .getThreadMessages(account, encodeThreadId('Quarterly report (2026)', 'INBOX', 1))
      .then((messages) => {
        expect(messages.map((message) => message.subject)).toEqual(['Quarterly report'])
      })
  })
})

/**
 * A conversation you can see in a list can be opened.
 *
 * The property, rather than any particular query being right. Two attempts at
 * finding the right string to hand a search engine both failed against a real
 * Gmail account — the whole subject, then a punctuation-free stretch of it —
 * while the message sat in the inbox the same code had just listed. Guessing at
 * what a search will accept does not converge.
 *
 * Reading the mailbox does. It is what the listing already does, it is the same
 * comparison, and every IMAP server does it the same way.
 */
describe('a mailbox whose search disagrees with its contents', () => {
  beforeEach(() => {
    imap.subjectSearchFindsNothing = true
  })

  it('opens the conversation anyway', async () => {
    imap.messages.set('INBOX', [
      { uid: 1, subject: 'Quarterly report', messageId: '<a@example.com>' }
    ])

    const messages = await adapter.getThreadMessages(
      account,
      encodeThreadId('Quarterly report', 'INBOX', 1)
    )

    expect(messages.map((message) => message.subject)).toEqual(['Quarterly report'])
  })

  it('collects the replies with it', async () => {
    imap.messages.set('INBOX', [
      { uid: 1, subject: 'Quarterly report', messageId: '<a@example.com>' },
      { uid: 2, subject: 'Re: Quarterly report', messageId: '<b@example.com>' }
    ])

    const messages = await adapter.getThreadMessages(
      account,
      encodeThreadId('Quarterly report', 'INBOX', 1)
    )

    expect(messages).toHaveLength(2)
  })

  it('does not sweep in the rest of the mailbox', async () => {
    // Reading the folder means everything in it passes under this code. The
    // subject comparison is the only thing keeping the thread to itself, and
    // `applyFlag` and `move` act on whatever a thread resolves to.
    imap.messages.set('INBOX', [
      { uid: 1, subject: 'Quarterly report', messageId: '<a@example.com>' },
      { uid: 2, subject: 'Lunch', messageId: '<c@example.com>' },
      { uid: 3, subject: 'Quarterly report 2027', messageId: '<d@example.com>' }
    ])

    const messages = await adapter.getThreadMessages(
      account,
      encodeThreadId('Quarterly report', 'INBOX', 1)
    )

    expect(messages.map((message) => message.subject)).toEqual(['Quarterly report'])
  })

  it('still answers nothing when the mailbox genuinely has nothing', async () => {
    // The honest empty. `getThreadMessages` logs it and both readers now say so
    // rather than drawing a blank page, so this must stay distinguishable from
    // a server that would not search.
    imap.messages.set('INBOX', [{ uid: 1, subject: 'Lunch', messageId: '<c@example.com>' }])

    const messages = await adapter.getThreadMessages(
      account,
      encodeThreadId('Quarterly report', 'INBOX', 1)
    )

    expect(messages).toEqual([])
  })
})

/**
 * A message that is not in the inbox.
 *
 * Every act on a thread resolves through `getThreadMessages` -- `resolveTargets`
 * uses it for flag, move and trash alike -- and it searched INBOX and Sent and
 * nowhere else. So outside those two folders *nothing worked*: a message in the
 * trash could not be opened, starred, restored or deleted, and the two symptoms
 * ("this conversation would not open", "that conversation has no messages")
 * were the same wrong assumption seen from two directions.
 *
 * Found by using it. A test swipe put a message in the trash and the app could
 * not get it back out.
 */
describe('a thread outside the inbox', () => {
  it('can be read', async () => {
    imap.messages.set(TRASH, [
      { uid: 5, subject: 'Quarterly report', messageId: '<a@example.com>' }
    ])

    const messages = await adapter.getThreadMessages(
      account,
      encodeThreadId('Quarterly report', 'INBOX', 1)
    )

    expect(messages.map((message) => message.subject)).toEqual(['Quarterly report'])
  })

  it('can be moved back to the inbox', async () => {
    // The act that was impossible: delete something by accident, then put it
    // back. Move resolves the thread the same way a read does, so it failed for
    // the same reason and is fixed by the same change.
    imap.messages.set(TRASH, [
      { uid: 5, subject: 'Quarterly report', messageId: '<a@example.com>' }
    ])

    await adapter.move(account, {
      threadId: encodeThreadId('Quarterly report', 'INBOX', 1),
      mailbox: 'INBOX'
    })

    expect(imap.moves).toEqual([{ from: TRASH, uids: '5', to: 'INBOX' }])
  })

  it('prefers the inbox copy when there is one', async () => {
    // The fallback must stay a fallback. A thread in the inbox is answered from
    // the inbox without touching another folder, or every ordinary read would
    // pay for the rare one.
    imap.messages.set('INBOX', [
      { uid: 1, subject: 'Quarterly report', messageId: '<a@example.com>' }
    ])
    imap.messages.set(TRASH, [
      { uid: 5, subject: 'Quarterly report', messageId: '<old@example.com>' }
    ])

    const messages = await adapter.getThreadMessages(
      account,
      encodeThreadId('Quarterly report', 'INBOX', 1)
    )

    expect(messages.map((message) => message.messageIdHeader)).toEqual(['<a@example.com>'])
  })

  it('still answers nothing when the account genuinely has nothing', async () => {
    // The honest empty has to survive a wider search, or "this conversation
    // would not open" stops being true when it is.
    const messages = await adapter.getThreadMessages(
      account,
      encodeThreadId('Never existed', 'INBOX', 1)
    )

    expect(messages).toEqual([])
  })
})
