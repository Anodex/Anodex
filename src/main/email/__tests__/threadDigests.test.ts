import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessage } from '@shared/email.types'

const getThreadMessages = vi.fn<(threadId: string, accountId?: string) => Promise<EmailMessage[]>>()
const digestEmailThread = vi.fn<(rendered: string) => Promise<string | null>>()
const canSummarize = vi.fn<() => boolean>()

vi.mock('../EmailService', () => ({
  emailService: {
    getThreadMessages: (threadId: string, accountId?: string): Promise<EmailMessage[]> =>
      getThreadMessages(threadId, accountId)
  }
}))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: {
    digestEmailThread: (rendered: string): Promise<string | null> => digestEmailThread(rendered),
    canSummarize: (): boolean => canSummarize()
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
    canSummarize.mockReset()
    getThreadMessages.mockResolvedValue([message()])
    digestEmailThread.mockResolvedValue('Dana wants the seat count corrected to 48.')
    canSummarize.mockReturnValue(true)
  })

  it('digests a thread and serves the repeat from cache', async () => {
    const cached = request({ threadId: 'cached', latestMessageId: 'm1' })
    const first = await digestThreads([cached])
    const second = await digestThreads([cached])

    expect(first.digests).toEqual([
      { threadId: 'cached', digest: 'Dana wants the seat count corrected to 48.' }
    ])
    expect(first.outcome).toBe('ok')
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

    await expect(first).resolves.toMatchObject({
      digests: [{ threadId: 'overlapping', digest: 'Dana wants the seat count corrected to 48.' }]
    })
    await expect(second).resolves.toMatchObject({
      digests: [{ threadId: 'overlapping', digest: 'Dana wants the seat count corrected to 48.' }]
    })
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
    expect(first.digests).toHaveLength(5)
    expect(second.digests).toHaveLength(9)
  })

  it('omits threads the model could not summarize instead of caching an empty digest', async () => {
    digestEmailThread.mockResolvedValue(null)

    const refused = request({ threadId: 'refused', latestMessageId: 'm1' })
    const withoutDigest = await digestThreads([refused])
    digestEmailThread.mockResolvedValue('Dana wants the seat count corrected to 48.')
    const withDigest = await digestThreads([refused])

    // A model that answers with nothing usable is the one real fault here, and
    // it must not be cached — the next pass gets to try again.
    expect(withoutDigest).toEqual({ digests: [], outcome: 'failed', abandonedThreadIds: [] })
    expect(withDigest.digests).toHaveLength(1)
    expect(withDigest.outcome).toBe('ok')
  })

  it('reports no engine as its own outcome, without spending a mailbox fetch', async () => {
    canSummarize.mockReturnValue(false)

    const loading = request({ threadId: 'still-loading', latestMessageId: 'm1' })
    const duringLoad = await digestThreads([loading])

    // The distinction the list depends on: a model that has not finished
    // loading is not a failure, and telling the reader it is was how a working
    // feature came to show a permanent error.
    expect(duringLoad).toEqual({
      digests: [],
      outcome: 'engine-unavailable',
      abandonedThreadIds: []
    })
    expect(getThreadMessages).not.toHaveBeenCalled()

    canSummarize.mockReturnValue(true)
    const afterLoad = await digestThreads([loading])
    expect(afterLoad.digests).toHaveLength(1)
  })

  it('keeps going when one thread fails to load', async () => {
    getThreadMessages.mockImplementation((threadId: string) =>
      threadId === 'broken'
        ? Promise.reject(new Error('IMAP timeout'))
        : Promise.resolve([message()])
    )

    const batch = await digestThreads([
      request({ threadId: 'broken', latestMessageId: 'x1' }),
      request({ threadId: 'intact', latestMessageId: 'x2' })
    ])

    expect(batch.digests).toEqual([
      { threadId: 'intact', digest: 'Dana wants the seat count corrected to 48.' }
    ])
    expect(batch.outcome).toBe('failed')
  })

  it('gives up on a thread that keeps failing to load, and says so', async () => {
    getThreadMessages.mockRejectedValue(new Error('404 no such thread'))

    const gone = request({ threadId: 'gone', latestMessageId: 'g1' })
    const first = await digestThreads([gone])
    const second = await digestThreads([gone])
    const third = await digestThreads([gone])

    // Retried once, then abandoned by name. Without this the thread stayed
    // pending forever, refilled the budget ahead of everything else on every
    // pass, and made each pass come back empty.
    expect(first.abandonedThreadIds).toEqual([])
    expect(second.abandonedThreadIds).toEqual(['gone'])
    expect(third).toEqual({ digests: [], outcome: 'ok', abandonedThreadIds: ['gone'] })
    expect(getThreadMessages).toHaveBeenCalledTimes(2)
  })

  it('abandons a thread with nothing in it rather than asking again', async () => {
    getThreadMessages.mockResolvedValue([])

    const empty = request({ threadId: 'empty', latestMessageId: 'e1' })
    const first = await digestThreads([empty])
    const second = await digestThreads([empty])

    expect(first).toEqual({ digests: [], outcome: 'ok', abandonedThreadIds: ['empty'] })
    expect(second).toEqual(first)
    expect(getThreadMessages).toHaveBeenCalledTimes(1)
    expect(digestEmailThread).not.toHaveBeenCalled()
  })

  it('takes another look once a reply lands in an abandoned thread', async () => {
    getThreadMessages.mockResolvedValue([])
    await digestThreads([request({ threadId: 'revived', latestMessageId: 'r1' })])

    getThreadMessages.mockResolvedValue([message()])
    const afterReply = await digestThreads([
      request({ threadId: 'revived', latestMessageId: 'r2' })
    ])

    expect(afterReply.digests).toHaveLength(1)
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
