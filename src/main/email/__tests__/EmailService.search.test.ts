import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailThreadSummary } from '@shared/email.types'

/**
 * Which mailbox a search searches.
 *
 * A reader looking at one folder and typing a word means that folder. Searching
 * the whole account from inside Trash answers a question nobody asked, with mail
 * that is not in front of them — and on the phone, where the folder strip is the
 * only thing saying where you are, the results look like the folder's contents.
 *
 * Every adapter already took a mailbox alongside a query; only the request shape
 * dropped it. The Microsoft adapter carries a comment about the same omission
 * one layer down, where it caused a batch action to sweep outside the folder
 * being previewed.
 */

const listThreads = vi.fn<(options: Record<string, unknown>) => Promise<EmailThreadSummary[]>>()

const account: EmailAccount = {
  id: 'account-1',
  provider: 'gmail',
  address: 'one@gmail.com',
  displayName: 'one',
  authKind: 'oauth',
  syncMode: 'metadata',
  createdAt: 0
}

vi.mock('../EmailAccountStore', () => ({
  emailAccountStore: { resolve: () => account, list: () => [account] }
}))
vi.mock('../EmailAuthStore', () => ({ emailAuthStore: { hasCredentials: () => true } }))
vi.mock('../providers/GmailAdapter', () => ({
  GmailAdapter: class {
    provider = 'gmail'
    listThreads(_account: EmailAccount, options: Record<string, unknown>) {
      return listThreads(options)
    }
  }
}))
vi.mock('../providers/MicrosoftAdapter', () => ({ MicrosoftAdapter: class {} }))
vi.mock('../providers/ImapSmtpAdapter', () => ({ ImapSmtpAdapter: class {} }))

const { emailService } = await import('../EmailService')

beforeEach(() => {
  listThreads.mockReset()
  listThreads.mockResolvedValue([])
})

describe('EmailService — search', () => {
  it('searches the folder it was given', async () => {
    await emailService.search({ query: 'invoice', mailbox: '[Gmail]/Trash' })

    expect(listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'invoice', mailbox: '[Gmail]/Trash' })
    )
  })

  it('searches the account when no folder is named', async () => {
    // Unchanged, and the common case: a search from the inbox means everywhere,
    // because the thing being looked for is usually the thing that is not in
    // front of you.
    await emailService.search({ query: 'invoice' })

    const options = listThreads.mock.calls[0][0]
    expect(options.query).toBe('invoice')
    expect(options.mailbox).toBeUndefined()
  })

  it('treats a blank folder as no folder', async () => {
    // A caller passing through an empty string is passing through "the default",
    // and a mailbox named "" is a folder no server has.
    await emailService.search({ query: 'invoice', mailbox: '  ' })

    expect(listThreads.mock.calls[0][0].mailbox).toBeUndefined()
  })
})
