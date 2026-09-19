import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailMessage } from '@shared/email.types'

/**
 * A conversation that cannot be read is a failure, not an empty conversation.
 *
 * The comment above `getThreadMessages` has said "zero messages is a fault,
 * not a result" for months, directly above a line that returned it as a
 * result. Every reader then drew the empty array the only way an empty array
 * can be drawn — as a conversation with nothing in it, which is a claim about
 * the mail rather than a report about the lookup.
 *
 * Seen again in the user's own log on 2026-09-19: a warning that a thread had
 * no readable messages, and eighteen seconds later a failed archive on the
 * same thread. Somebody opened a conversation, was shown nothing, and reached
 * for the only other thing on the screen.
 */

const getThreadMessages = vi.fn<(account: EmailAccount, id: string) => Promise<EmailMessage[]>>()

const account: EmailAccount = {
  id: 'account-1',
  provider: 'imap',
  address: 'one@example.com',
  displayName: 'one',
  authKind: 'password',
  syncMode: 'metadata',
  createdAt: 0
}

vi.mock('../EmailAccountStore', () => ({
  emailAccountStore: { resolve: () => account, list: () => [account] }
}))
vi.mock('../EmailAuthStore', () => ({ emailAuthStore: { hasCredentials: () => true } }))
vi.mock('../providers/GmailAdapter', () => ({ GmailAdapter: class {} }))
vi.mock('../providers/MicrosoftAdapter', () => ({ MicrosoftAdapter: class {} }))
vi.mock('../providers/ImapSmtpAdapter', () => ({
  ImapSmtpAdapter: class {
    provider = 'imap'
    getThreadMessages(target: EmailAccount, id: string): Promise<EmailMessage[]> {
      return getThreadMessages(target, id)
    }
  }
}))

const { emailService, THREAD_UNREADABLE } = await import('../EmailService')

function message(): EmailMessage {
  return {
    id: 'msg.INBOX:12',
    threadId: 'subj.abc',
    accountId: 'account-1',
    provider: 'imap',
    subject: 'Quarterly report',
    from: 'Ada <ada@example.com>',
    to: [],
    cc: [],
    bcc: [],
    date: 1_760_000_000_000,
    snippet: '',
    body: 'The numbers are attached.',
    attachments: []
  }
}

beforeEach(() => {
  getThreadMessages.mockReset()
})

describe('EmailService — a thread that cannot be read', () => {
  it('refuses rather than answering with an empty conversation', async () => {
    getThreadMessages.mockResolvedValue([])

    await expect(emailService.getThreadMessages('subj.abc')).rejects.toThrow(THREAD_UNREADABLE)
  })

  it('says what happened, not what is true of the mailbox', async () => {
    // The wording is the fix. "That conversation has no messages" is a
    // statement about the mail, so it gets read as one and nobody looks --
    // which is exactly how the original went unnoticed for weeks. And now
    // that the phone repeats the computer's own sentence, this string is what
    // somebody standing in a kitchen actually reads.
    getThreadMessages.mockResolvedValue([])

    const said = await emailService
      .getThreadMessages('subj.abc')
      .then(() => '')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))

    expect(said).toMatch(/could not read/i)
    expect(said).not.toMatch(/has no messages/i)
  })

  it('still answers normally when there is something to read', async () => {
    getThreadMessages.mockResolvedValue([message()])

    const messages = await emailService.getThreadMessages('subj.abc')

    expect(messages).toHaveLength(1)
  })

  it('sorts what it does find oldest first', async () => {
    // Unchanged behaviour, pinned here because the early return above it is
    // new and a `throw` in the wrong place would skip this.
    const older = { ...message(), id: 'msg.INBOX:1', date: 1 }
    const newer = { ...message(), id: 'msg.INBOX:2', date: 2 }
    getThreadMessages.mockResolvedValue([newer, older])

    const messages = await emailService.getThreadMessages('subj.abc')

    expect(messages.map((one) => one.id)).toEqual(['msg.INBOX:1', 'msg.INBOX:2'])
  })
})
