import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailMessage } from '@shared/email.types'
import type { EmailAttachmentContent } from '../providers/types'
import { MAX_ATTACHMENT_TOTAL_BYTES } from '../mime'

const account: EmailAccount = {
  id: 'account-1',
  provider: 'gmail',
  address: 'user@gmail.com',
  displayName: 'user@gmail.com',
  authKind: 'oauth',
  syncMode: 'metadata',
  createdAt: 0
}

const readMessage = vi.fn<() => Promise<EmailMessage>>()
const getAttachment = vi.fn<() => Promise<EmailAttachmentContent>>()
const applyFlag = vi.fn<(account: EmailAccount, target: unknown) => Promise<string>>()
const move = vi.fn<(account: EmailAccount, target: unknown) => Promise<string>>()

vi.mock('../EmailAccountStore', () => ({
  emailAccountStore: { resolve: () => account }
}))
vi.mock('../EmailAuthStore', () => ({
  emailAuthStore: { hasCredentials: () => true }
}))
// Methods, not field initializers: `ADAPTERS` constructs an adapter at module
// load, which is before these `vi.fn()` consts exist. A method body only
// touches them when a test actually calls it.
vi.mock('../providers/GmailAdapter', () => ({
  GmailAdapter: class {
    provider = 'gmail'
    readMessage(): Promise<EmailMessage> {
      return readMessage()
    }
    getAttachment(): Promise<EmailAttachmentContent> {
      return getAttachment()
    }
    applyFlag(account: EmailAccount, target: unknown): Promise<string> {
      return applyFlag(account, target)
    }
    move(account: EmailAccount, target: unknown): Promise<string> {
      return move(account, target)
    }
  }
}))
vi.mock('../providers/MicrosoftAdapter', () => ({ MicrosoftAdapter: class {} }))
vi.mock('../providers/ImapSmtpAdapter', () => ({ ImapSmtpAdapter: class {} }))

import { emailService } from '../EmailService'

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'message-1',
    threadId: 'thread-1',
    provider: 'gmail',
    accountId: 'account-1',
    subject: 'Concept',
    from: 'Gabriel <gabe@example.com>',
    to: ['user@gmail.com'],
    cc: [],
    bcc: [],
    date: Date.UTC(2026, 6, 26),
    snippet: '',
    body: 'Here is the concept.',
    attachments: [],
    messageIdHeader: '<parent@example.com>',
    references: ['<older@example.com>'],
    ...overrides
  }
}

const imageAttachment = {
  id: 'attachment-1',
  messageId: 'message-1',
  filename: 'mascot.png',
  mimeType: 'image/png',
  size: 4
}

describe('prepareForward', () => {
  beforeEach(() => {
    readMessage.mockReset()
    getAttachment.mockReset()
  })

  it('quotes the original under an attribution block', async () => {
    readMessage.mockResolvedValue(message())

    const prepared = await emailService.prepareForward({
      messageId: 'message-1',
      to: ['friend@example.com'],
      body: 'Thought you would like this'
    })

    expect(prepared.message.subject).toBe('Fwd: Concept')
    expect(prepared.message.body).toContain('Thought you would like this')
    expect(prepared.message.body).toContain('---------- Forwarded message ----------')
    expect(prepared.message.body).toContain('Here is the concept.')
  })

  it('starts a new conversation rather than joining the original thread', async () => {
    // Filing a forward into the parent thread would show it to people who were
    // never meant to see it, or bury it in a thread the recipient cannot read.
    readMessage.mockResolvedValue(message())

    const prepared = await emailService.prepareForward({
      messageId: 'message-1',
      to: ['friend@example.com']
    })

    expect(prepared.message.threadId).toBeUndefined()
    expect(prepared.message.inReplyTo).toBeUndefined()
    expect(prepared.message.references).toBeUndefined()
  })

  it('carries the original attachments, which is the point of forwarding a photo', async () => {
    readMessage.mockResolvedValue(message({ attachments: [imageAttachment] }))
    getAttachment.mockResolvedValue({ ...imageAttachment, data: Buffer.from('abcd') })

    const prepared = await emailService.prepareForward({
      messageId: 'message-1',
      to: ['friend@example.com']
    })

    expect(prepared.message.attachments).toEqual([
      {
        filename: 'mascot.png',
        mimeType: 'image/png',
        contentBase64: Buffer.from('abcd').toString('base64')
      }
    ])
  })

  it('can forward the text alone when asked', async () => {
    readMessage.mockResolvedValue(message({ attachments: [imageAttachment] }))

    const prepared = await emailService.prepareForward({
      messageId: 'message-1',
      to: ['friend@example.com'],
      includeAttachments: false
    })

    expect(prepared.message.attachments).toEqual([])
    expect(getAttachment).not.toHaveBeenCalled()
  })

  it('fails locally with the reason when the attachments exceed what providers accept', async () => {
    // The parent's attachments are not something the caller chose, so this has
    // to explain itself rather than surface as an opaque rejection at send time.
    readMessage.mockResolvedValue(message({ attachments: [imageAttachment] }))
    getAttachment.mockResolvedValue({
      ...imageAttachment,
      data: Buffer.alloc(MAX_ATTACHMENT_TOTAL_BYTES + 1)
    })

    await expect(
      emailService.prepareForward({ messageId: 'message-1', to: ['friend@example.com'] })
    ).rejects.toThrow(/total more than 18MB/)
  })

  it('requires a recipient', async () => {
    readMessage.mockResolvedValue(message())

    await expect(
      emailService.prepareForward({ messageId: 'message-1', to: ['   '] })
    ).rejects.toThrow(/recipient/)
  })
})

describe('applyBatch', () => {
  beforeEach(() => {
    applyFlag.mockReset()
    move.mockReset()
  })

  it('reports how much of the sweep landed', async () => {
    applyFlag.mockResolvedValue('Archived')

    const result = await emailService.applyBatch({
      accountId: 'account-1',
      threadIds: ['thread-1', 'thread-2'],
      action: 'archive'
    })

    expect(applyFlag).toHaveBeenCalledTimes(2)
    expect(result).toContain('2 of 2 threads updated')
  })

  it('finishes the rest of the batch when one thread fails, and says which', async () => {
    // Stopping at the first failure would leave a half-finished sweep with no
    // record of where it stopped.
    applyFlag.mockRejectedValueOnce(new Error('Thread is gone')).mockResolvedValueOnce('Archived')

    const result = await emailService.applyBatch({
      accountId: 'account-1',
      threadIds: ['thread-1', 'thread-2'],
      action: 'archive'
    })

    expect(applyFlag).toHaveBeenCalledTimes(2)
    expect(result).toContain('1 of 2 threads updated')
    expect(result).toContain('thread-1: Thread is gone')
  })

  it('moves each thread to the destination when that is the action', async () => {
    move.mockResolvedValue('Moved')

    await emailService.applyBatch({
      accountId: 'account-1',
      threadIds: ['thread-1'],
      action: 'move',
      destination: 'Archive'
    })

    expect(move).toHaveBeenCalledWith(account, { threadId: 'thread-1', mailbox: 'Archive' })
  })

  it('counts a move with no destination as a failure rather than dropping mail somewhere', async () => {
    const result = await emailService.applyBatch({
      accountId: 'account-1',
      threadIds: ['thread-1'],
      action: 'move'
    })

    expect(move).not.toHaveBeenCalled()
    expect(result).toContain('0 of 1 thread updated')
    expect(result).toContain('destination mailbox is required')
  })
})
