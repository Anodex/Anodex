import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessage } from '@shared/email.types'

const getThreadMessages = vi.fn<(threadId: string, accountId?: string) => Promise<EmailMessage[]>>()
const digestEmailThread = vi.fn<(rendered: string) => Promise<string | null>>()

vi.mock('../EmailService', () => ({
  emailService: {
    getThreadMessages: (threadId: string, accountId?: string): Promise<EmailMessage[]> =>
      getThreadMessages(threadId, accountId)
  }
}))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: {
    digestEmailThread: (rendered: string): Promise<string | null> => digestEmailThread(rendered)
  }
}))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const { digestThreads } = await import('../threadDigests')

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    provider: 'gmail',
    accountId: 'a1',
    subject: 'Q3 renewal',
    from: 'Dana Okafor <dana@example.com>',
    to: ['me@example.com'],
    date: 1,
    snippet: 'seat count',
    body: 'The tier 2 line still shows 40 seats. We are at 48.',
    attachments: [],
    ...overrides
  } as EmailMessage
}

function request(overrides: Record<string, string> = {}): {
  accountId: string
  threadId: string
  latestMessageId: string
} {
  return { accountId: 'a1', threadId: 't1', latestMessageId: 'm1', ...overrides }
}

describe('digestThreads', () => {
  // The digest cache is module state that deliberately outlives a single
  // request, so each test works on thread ids no other test has used rather
  // than reaching in to clear it.
  beforeEach(() => {
    getThreadMessages.mockReset()
    digestEmailThread.mockReset()
    getThreadMessages.mockResolvedValue([message()])
    digestEmailThread.mockResolvedValue('Dana wants the seat count corrected to 48.')
  })

  it('digests a thread and serves the repeat from cache', async () => {
    const cached = request({ threadId: 'cached', latestMessageId: 'm1' })
    const first = await digestThreads([cached])
    const second = await digestThreads([cached])

    expect(first).toEqual([
      { threadId: 'cached', digest: 'Dana wants the seat count corrected to 48.' }
    ])
    expect(second).toEqual(first)
    // The second call is the point: neither the mailbox nor the model is
    // touched again for a thread that has not changed.
    expect(getThreadMessages).toHaveBeenCalledTimes(1)
    expect(digestEmailThread).toHaveBeenCalledTimes(1)
  })

  it('shares a digest already in progress with an overlapping caller', async () => {
    let finishDigest: ((digest: string) => void) | undefined
    digestEmailThread.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDigest = resolve
        })
    )

    const overlapping = request({ threadId: 'overlapping', latestMessageId: 'm1' })
    const first = digestThreads([overlapping])
    await vi.waitFor(() => expect(digestEmailThread).toHaveBeenCalledTimes(1))
    const second = digestThreads([overlapping])

    finishDigest?.('Dana wants the seat count corrected to 48.')

    await expect(first).resolves.toEqual([
      { threadId: 'overlapping', digest: 'Dana wants the seat count corrected to 48.' }
    ])
    await expect(second).resolves.toEqual([
      { threadId: 'overlapping', digest: 'Dana wants the seat count corrected to 48.' }
    ])
    expect(getThreadMessages).toHaveBeenCalledTimes(1)
    expect(digestEmailThread).toHaveBeenCalledTimes(1)
  })

  it('regenerates once a newer message lands in the thread', async () => {
    await digestThreads([request({ threadId: 'moving', latestMessageId: 'm1' })])
    await digestThreads([request({ threadId: 'moving', latestMessageId: 'm2' })])

    expect(digestEmailThread).toHaveBeenCalledTimes(2)
  })

  it('generates at most a budget of digests per call, leaving the rest for later', async () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      request({ threadId: `budget-${index}`, latestMessageId: `m${index}` })
    )

    const first = await digestThreads(many)
    const second = await digestThreads(many)

    // A first look at a full inbox must not mean one mailbox fetch and one
    // model call per row before anything can render.
    expect(first).toHaveLength(5)
    expect(second).toHaveLength(9)
  })

  it('omits threads the model could not summarize instead of caching an empty digest', async () => {
    // What a machine with no model loaded sees — the row keeps its snippet.
    digestEmailThread.mockResolvedValue(null)

    const noModel = request({ threadId: 'no-model', latestMessageId: 'm1' })
    const withoutModel = await digestThreads([noModel])
    digestEmailThread.mockResolvedValue('Dana wants the seat count corrected to 48.')
    const withModel = await digestThreads([noModel])

    expect(withoutModel).toEqual([])
    expect(withModel).toHaveLength(1)
  })

  it('keeps going when one thread fails to load', async () => {
    getThreadMessages.mockImplementation((threadId: string) =>
      threadId === 'broken'
        ? Promise.reject(new Error('IMAP timeout'))
        : Promise.resolve([message()])
    )

    const results = await digestThreads([
      request({ threadId: 'broken', latestMessageId: 'x1' }),
      request({ threadId: 'intact', latestMessageId: 'x2' })
    ])

    expect(results).toEqual([
      { threadId: 'intact', digest: 'Dana wants the seat count corrected to 48.' }
    ])
  })

  it('shows the model the newest messages, not the oldest', async () => {
    getThreadMessages.mockResolvedValue([
      message({ id: 'old', date: 1, body: 'Kicking this off.' }),
      message({ id: 'a', date: 2, body: 'Legal cleared the terms.' }),
      message({ id: 'b', date: 3, body: 'Seat count is wrong.' }),
      message({ id: 'c', date: 4, body: 'Can we move the date?' })
    ])

    await digestThreads([request({ threadId: 'ordering', latestMessageId: 'c' })])

    const rendered = digestEmailThread.mock.calls[0][0]
    expect(rendered).toContain('Can we move the date?')
    expect(rendered).not.toContain('Kicking this off.')
  })
})
