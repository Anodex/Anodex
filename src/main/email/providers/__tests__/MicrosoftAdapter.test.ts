import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount } from '@shared/email.types'

/**
 * The Outlook/Graph adapter's first direct coverage. The audit table credited
 * it with two tests; both turned out to be `vi.mock` stubs in `EmailService`'s
 * suites, which mention the class without exercising a line of it.
 *
 * These assert the requests it puts on the wire, which is where both of its
 * defects lived — Graph is mocked at `fetch`, the same way `webTools.test.ts`
 * does it.
 */

vi.mock('../oauthClients', () => ({ accessTokenFor: () => Promise.resolve('token') }))

const { MicrosoftAdapter } = await import('../MicrosoftAdapter')

const account: EmailAccount = {
  id: 'account-1',
  provider: 'microsoft',
  address: 'user@outlook.com',
  displayName: 'user',
  authKind: 'oauth',
  syncMode: 'metadata',
  createdAt: 0
}

/** Every Graph path requested, in order. */
let requested: string[] = []

/** Reply to each request in turn; anything unscripted returns an empty list. */
function respondWith(...bodies: unknown[]): void {
  const queue = [...bodies]
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    requested.push(String(url))
    const body = queue.shift() ?? { value: [] }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
      text: () => Promise.resolve('')
    })
  })
}

beforeEach(() => {
  requested = []
})

describe('MicrosoftAdapter — listThreads scoping', () => {
  it('searches inside the named folder rather than the whole mailbox', async () => {
    // `previewBatch` passes a query and a mailbox together, and the search path
    // used to drop the folder — so "archive everything matching X in Archive"
    // previewed matches from every folder, and `applyBatch` acted on those ids.
    respondWith({ value: [] })

    await new MicrosoftAdapter().listThreads(account, {
      limit: 10,
      query: 'invoice',
      mailbox: 'archive'
    })

    expect(requested[0]).toContain('/mailFolders/archive/messages')
    expect(requested[0]).toContain('%24search=')
  })

  it('still searches the whole mailbox when no folder was named', async () => {
    // Ordinary search is unscoped on purpose; narrowing it to the inbox would
    // be a regression, not a fix.
    respondWith({ value: [] })

    await new MicrosoftAdapter().listThreads(account, { limit: 10, query: 'invoice' })

    expect(requested[0]).toContain('/messages?')
    expect(requested[0]).not.toContain('/mailFolders/')
  })

  it('still lists the inbox when there is neither a query nor a folder', async () => {
    respondWith({ value: [] })

    await new MicrosoftAdapter().listThreads(account, { limit: 10 })

    expect(requested[0]).toContain('/mailFolders/inbox/messages')
  })
})

describe('MicrosoftAdapter — bulk actions on a long thread', () => {
  it('acts on every message, not just the first page the reader would show', async () => {
    // Flag and move targets used to expand a thread through `getThreadMessages`,
    // which caps at 50 because it fetches bodies for the reading pane. A long
    // mailing-list thread was therefore part-archived, and the count reported
    // back said 50 as though that were the whole thing.
    const messages = Array.from({ length: 120 }, (_, index) => ({ id: `m${index}` }))
    respondWith({ value: messages })

    const result = await new MicrosoftAdapter().applyFlag(account, {
      threadId: 'thread-1',
      action: 'mark_read'
    })

    expect(result).toContain('120 messages')
    // Ids only, and a ceiling well past what a reader's page would carry.
    expect(requested[0]).toContain('%24select=id')
    expect(requested[0]).toContain('%24top=500')
  })

  it('refuses a thread that resolved to no messages', async () => {
    respondWith({ value: [] })

    await expect(
      new MicrosoftAdapter().applyFlag(account, { threadId: 'ghost', action: 'star' })
    ).rejects.toThrow('no messages')
  })
})
