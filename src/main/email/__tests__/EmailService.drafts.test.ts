import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailThreadSummary } from '@shared/email.types'

/**
 * Draft retention, and the two other places `EmailService` handled account
 * state loosely.
 *
 * `createDraft` holds a message in process memory so `send_email` can be handed
 * an id. Nothing deleted one except a successful send quoting that id, so every
 * abandoned draft — recipients, subject, body, and attachments as base64 —
 * stayed for the life of the process, and both the model and the Email page can
 * create them freely.
 */

const listThreads = vi.fn<() => Promise<EmailThreadSummary[]>>()

const accounts: EmailAccount[] = [
  {
    id: 'account-1',
    provider: 'gmail',
    address: 'one@gmail.com',
    displayName: 'one',
    authKind: 'oauth',
    syncMode: 'metadata',
    createdAt: 0
  },
  {
    id: 'account-2',
    provider: 'gmail',
    address: 'two@gmail.com',
    displayName: 'two',
    authKind: 'oauth',
    syncMode: 'metadata',
    createdAt: 0
  },
  {
    id: 'disconnected',
    provider: 'gmail',
    address: 'stale@gmail.com',
    displayName: 'stale',
    authKind: 'oauth',
    syncMode: 'metadata',
    createdAt: 0
  }
]

vi.mock('../EmailAccountStore', () => ({
  emailAccountStore: {
    resolve: () => accounts[0],
    list: () => accounts
  }
}))
vi.mock('../EmailAuthStore', () => ({
  emailAuthStore: {
    // Everything except the account that was linked and then lost its token.
    hasCredentials: (id: string) => id !== 'disconnected'
  }
}))
// Methods, not field initializers — see `EmailService.forward.test.ts` for why.
vi.mock('../providers/GmailAdapter', () => ({
  GmailAdapter: class {
    provider = 'gmail'
    listThreads(): Promise<EmailThreadSummary[]> {
      return listThreads()
    }
  }
}))
vi.mock('../providers/MicrosoftAdapter', () => ({ MicrosoftAdapter: class {} }))
vi.mock('../providers/ImapSmtpAdapter', () => ({ ImapSmtpAdapter: class {} }))

const { emailService } = await import('../EmailService')

function draft(subject: string): { id: string } {
  return emailService.createDraft({
    to: ['someone@example.com'],
    subject,
    body: 'Body.'
  })
}

beforeEach(() => {
  listThreads.mockReset()
  listThreads.mockResolvedValue([])
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('EmailService — draft retention', () => {
  it('keeps a draft available for the handoff it exists for', () => {
    const created = draft('Same turn')

    expect(emailService.getDraft(created.id)?.subject).toBe('Same turn')
  })

  it('drops a draft the user never sent once it has aged out', () => {
    const abandoned = draft('Thought better of it')

    vi.advanceTimersByTime(61 * 60 * 1000)
    // Pruning happens on write rather than on a timer, so a later draft is what
    // collects the abandoned one.
    draft('Something else')

    expect(emailService.getDraft(abandoned.id)).toBeUndefined()
  })

  it('keeps a draft that has not aged out when a later one is created', () => {
    const recent = draft('Still wanted')

    vi.advanceTimersByTime(60 * 1000)
    draft('Something else')

    expect(emailService.getDraft(recent.id)?.subject).toBe('Still wanted')
  })

  it('evicts oldest-first once the retained count is reached', () => {
    // The backstop for a burst inside the TTL window — a model calling
    // create_email_draft in a loop must not grow memory without limit.
    const first = draft('Oldest')
    for (let i = 0; i < 60; i++) draft(`Filler ${i}`)

    expect(emailService.getDraft(first.id)).toBeUndefined()
    // And the newest survives, so eviction is not simply clearing the map.
    const newest = draft('Newest')
    expect(emailService.getDraft(newest.id)?.subject).toBe('Newest')
  })
})

describe('EmailService — account and input handling', () => {
  it('does not query an account that has no stored credentials', async () => {
    await emailService.searchAll({ query: 'invoice' })

    // `searchAll` is the one path that reaches an adapter without going through
    // `resolve`, so the disconnected account used to be called anyway and fail
    // inside `allSettled` — a warning standing in for a real message.
    expect(listThreads).toHaveBeenCalledTimes(2)
  })

  it('refuses a non-finite batch limit instead of passing it to the adapter', async () => {
    // Every step of the old inline clamp — min(max(1, floor(NaN)), 200) — is
    // also NaN, so it went straight through to the provider.
    await expect(emailService.previewBatch({ limit: Number.NaN })).rejects.toThrow('finite')
    expect(listThreads).not.toHaveBeenCalled()
  })

  it('clamps an oversized batch limit rather than refusing it', async () => {
    await emailService.previewBatch({ limit: 10_000 })

    expect(listThreads).toHaveBeenCalledTimes(1)
  })
})
