import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount } from '@shared/email.types'

/**
 * The Gmail adapter's first direct coverage. The round-three audit credited it
 * with zero tests, and that was the honest number: the only two files that
 * named it did so through `vi.mock('../providers/GmailAdapter')`, which is the
 * same mirage `MicrosoftAdapter` turned out to be carrying.
 *
 * Gmail is mocked at `fetch`, so these assert the requests the adapter puts on
 * the wire and the summaries it builds from the replies — which is where its
 * defects were.
 */

vi.mock('../oauthClients', () => ({ accessTokenFor: () => Promise.resolve('token') }))

const { GmailAdapter } = await import('../GmailAdapter')

const account: EmailAccount = {
  id: 'account-1',
  provider: 'gmail',
  address: 'user@gmail.com',
  displayName: 'user',
  authKind: 'oauth',
  syncMode: 'metadata',
  createdAt: 0
}

interface Recorded {
  url: string
  method: string
  body: unknown
}

let requests: Recorded[] = []

/** Reply to each request in turn; anything unscripted returns an empty object. */
function respondWith(...bodies: unknown[]): void {
  const queue = [...bodies]
  globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    })
    const body = queue.shift() ?? {}
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
      text: () => Promise.resolve('')
    })
  })
}

/** A Gmail label list containing the system labels the adapter reasons about. */
const LABELS = {
  labels: [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'Label_7', name: 'Receipts', type: 'user' }
  ]
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1',
    threadId: 't1',
    labelIds: [],
    internalDate: '1000',
    payload: { headers: [{ name: 'Subject', value: 'Hello' }] },
    ...overrides
  }
}

beforeEach(() => {
  requests = []
})

describe('GmailAdapter — move', () => {
  it('applies the label and drops the thread out of the inbox', async () => {
    respondWith(LABELS, {})

    const result = await new GmailAdapter().move(account, {
      threadId: 't1',
      mailbox: 'Receipts'
    })

    expect(requests[1].url).toContain('/threads/t1/modify')
    expect(requests[1].body).toEqual({ addLabelIds: ['Label_7'], removeLabelIds: ['INBOX'] })
    expect(result).toContain('Receipts')
  })

  // `move_email` accepts any name `list_mailboxes` returns, and that list
  // includes INBOX — the tool's description tells the model to choose from it.
  // So "put this back in my inbox" arrives as an ordinary move, and used to be
  // sent to Gmail as add-and-remove of the same label in one call.
  it('does not ask Gmail to add and remove INBOX in the same call', async () => {
    respondWith(LABELS, {})

    const result = await new GmailAdapter().move(account, { threadId: 't1', mailbox: 'INBOX' })

    expect(requests[1].body).toEqual({ addLabelIds: ['INBOX'], removeLabelIds: [] })
    expect(result).toBe('Moved back to the inbox')
  })

  it('matches a label by name case-insensitively, not just by id', async () => {
    respondWith(LABELS, {})

    await new GmailAdapter().move(account, { threadId: 't1', mailbox: 'inbox' })

    expect(requests[1].body).toEqual({ addLabelIds: ['INBOX'], removeLabelIds: [] })
  })

  it('refuses an unknown label and names the ones that exist', async () => {
    respondWith(LABELS)

    await expect(
      new GmailAdapter().move(account, { threadId: 't1', mailbox: 'Nowhere' })
    ).rejects.toThrow(/No Gmail label named "Nowhere".*Receipts/s)
  })
})

describe('GmailAdapter — thread summaries', () => {
  it('scopes a search to the named label instead of dropping one of the two', async () => {
    // The defect the Outlook adapter had. Asserted here so it stays absent.
    // The label lookup goes first, so the listing is the second request.
    respondWith(LABELS, { threads: [] })

    await new GmailAdapter().listThreads(account, {
      limit: 10,
      query: 'invoice',
      mailbox: 'Receipts'
    })

    expect(requests[1].url).toContain('q=invoice')
    expect(requests[1].url).toContain('labelIds=Label_7')
  })

  it('falls back to the inbox for a plain listing, and does not for a search', async () => {
    respondWith({ threads: [] })
    await new GmailAdapter().listThreads(account, { limit: 10 })
    expect(requests[0].url).toContain('labelIds=INBOX')

    requests = []
    respondWith({ threads: [] })
    await new GmailAdapter().listThreads(account, { limit: 10, query: 'invoice' })
    expect(requests[0].url).not.toContain('labelIds')
  })

  // Reading only the newest message made a thread whose latest reply had been
  // read look read, while `getUnreadThreadCount` — which asks Gmail for the
  // label's own `threadsUnread` — went on counting it.
  it('counts a thread as unread when an earlier message is still unread', async () => {
    respondWith(
      { threads: [{ id: 't1' }] },
      {
        id: 't1',
        messages: [
          message({ id: 'm1', internalDate: '1000', labelIds: ['UNREAD'] }),
          message({ id: 'm2', internalDate: '2000', labelIds: [] })
        ]
      }
    )

    const [thread] = await new GmailAdapter().listThreads(account, { limit: 10 })

    expect(thread.unread).toBe(true)
    // Still summarised by the newest message, which is what the list shows.
    expect(thread.latestMessageId).toBe('m2')
  })

  it('leaves a fully-read thread read', async () => {
    respondWith(
      { threads: [{ id: 't1' }] },
      {
        id: 't1',
        messages: [
          message({ id: 'm1', internalDate: '1000' }),
          message({ id: 'm2', internalDate: '2000' })
        ]
      }
    )

    const [thread] = await new GmailAdapter().listThreads(account, { limit: 10 })

    expect(thread.unread).toBe(false)
  })

  /**
   * A thread listing is fetched with `format=metadata`, which returns the MIME
   * structure but no `attachmentId` — so counting through `extractAttachments`,
   * which requires one, reported zero attachments on every thread in every
   * listing however many files were attached.
   */
  it('counts attachments on a metadata-format thread, which carries no attachment ids', async () => {
    respondWith(
      { threads: [{ id: 't1' }] },
      {
        id: 't1',
        messages: [
          message({
            payload: {
              mimeType: 'multipart/mixed',
              headers: [{ name: 'Subject', value: 'Invoices' }],
              parts: [
                { mimeType: 'text/plain', body: { size: 20 } },
                { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { size: 900 } },
                { mimeType: 'image/png', filename: 'chart.png', body: { size: 400 } }
              ]
            }
          })
        ]
      }
    )

    const [thread] = await new GmailAdapter().listThreads(account, { limit: 10 })

    expect(thread.attachmentCount).toBe(2)
  })
})

describe('GmailAdapter — message bodies', () => {
  function encode(text: string): string {
    return Buffer.from(text, 'utf-8').toString('base64url')
  }

  it('reads the plain-text part of a message', async () => {
    respondWith(
      message({
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'Subject', value: 'Hello' }],
          parts: [
            { mimeType: 'text/plain', body: { data: encode('the real body') } },
            { mimeType: 'text/html', body: { data: encode('<p>the real body</p>') } }
          ]
        }
      })
    )

    const result = await new GmailAdapter().readMessage(account, 'm1')

    expect(result.body).toBe('the real body')
  })

  // Gmail inlines a small part's bytes in `body.data` whether it is the message
  // or a file attached to it, so a short .txt attachment on a message with no
  // body of its own was read out as if the sender had written it.
  it('does not read a text attachment out as the message body', async () => {
    respondWith(
      message({
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: 'See attached' }],
          parts: [
            { mimeType: 'text/plain', body: { size: 0 } },
            {
              mimeType: 'text/plain',
              filename: 'notes.txt',
              body: { attachmentId: 'a1', size: 12, data: encode('attached file text') }
            }
          ]
        }
      })
    )

    const result = await new GmailAdapter().readMessage(account, 'm1')

    expect(result.body).toBe('')
    expect(result.attachments.map((a) => a.filename)).toEqual(['notes.txt'])
  })
})
