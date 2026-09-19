import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailThreadSummary } from '@shared/email.types'

/**
 * First coverage for the store behind the Email page. It is plain state with no
 * DOM, so the sequencing that matters here — superseded loads, in-flight
 * fetches being cancelled, and the digest loop's stopping conditions — can be
 * driven directly.
 */

/**
 * Typed as returning `unknown` rather than left bare: the mock factory below is
 * not checked against the real module, and an untyped `vi.fn()` makes every
 * arrow in it an unsafe `any` return.
 */
type Call = (...args: never[]) => unknown

const getStatus = vi.fn<Call>()
const listThreads = vi.fn<Call>()
const search = vi.fn<Call>()
const getUnreadThreadCount = vi.fn<Call>()
const getThreadMessages = vi.fn<Call>()
const applyFlag = vi.fn<Call>()
const listMailboxes = vi.fn<Call>()
const digestThreads = vi.fn<Call>()
const send = vi.fn<Call>()
const chatSend = vi.fn<Call>()
const notifyError = vi.fn<Call>()

vi.mock('../../lib/anodex', () => ({
  anodex: {
    email: {
      getStatus,
      listThreads,
      search,
      getUnreadThreadCount,
      getThreadMessages,
      applyFlag,
      listMailboxes,
      digestThreads,
      send
    },
    chat: { send: chatSend }
  }
}))

vi.mock('../uiStore', () => ({ notifyError }))

const { useEmailStore } = await import('../emailStore')
const initialState = useEmailStore.getState()

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function err(message = 'boom'): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: 'email.failed', message } }
}

function thread(overrides: Partial<EmailThreadSummary> = {}): EmailThreadSummary {
  return {
    id: 't1',
    latestMessageId: 'm1',
    provider: 'gmail',
    accountId: 'account-1',
    subject: 'Subject',
    from: 'sender@example.com',
    snippet: '',
    updatedAt: 0,
    unread: false,
    starred: false,
    messageCount: 1,
    attachmentCount: 0,
    ...overrides
  }
}

function threads(count: number): EmailThreadSummary[] {
  return Array.from({ length: count }, (_, i) => thread({ id: `t${i}`, latestMessageId: `m${i}` }))
}

/** A connected single-account status, which is the ordinary case. */
function connected(): { ok: true; value: { connected: boolean; accounts: { id: string }[] } } {
  return ok({ connected: true, accounts: [{ id: 'account-1' }] })
}

beforeEach(() => {
  vi.clearAllMocks()
  useEmailStore.setState(initialState, true)
  getStatus.mockResolvedValue(connected())
  listThreads.mockResolvedValue(ok([]))
  search.mockResolvedValue(ok([]))
  getUnreadThreadCount.mockResolvedValue(ok(0))
  listMailboxes.mockResolvedValue(ok([]))
  digestThreads.mockResolvedValue(ok({ digests: [], outcome: 'ok', abandonedThreadIds: [] }))
})

describe('load', () => {
  it('fills the listing and the unread count', async () => {
    listThreads.mockResolvedValue(ok(threads(3)))
    getUnreadThreadCount.mockResolvedValue(ok(7))

    await useEmailStore.getState().load()

    expect(useEmailStore.getState().threads).toHaveLength(3)
    expect(useEmailStore.getState().unreadCount).toBe(7)
    expect(useEmailStore.getState().loaded).toBe(true)
  })

  it('offers more only when the page came back full', async () => {
    listThreads.mockResolvedValue(ok(threads(20)))
    await useEmailStore.getState().load()
    expect(useEmailStore.getState().hasMore).toBe(true)

    listThreads.mockResolvedValue(ok(threads(4)))
    await useEmailStore.getState().load()
    expect(useEmailStore.getState().hasMore).toBe(false)
  })

  it('drops a selection whose account has been unlinked', async () => {
    useEmailStore.setState({ activeAccountId: 'gone' })

    await useEmailStore.getState().load()

    expect(useEmailStore.getState().activeAccountId).toBeNull()
  })

  it('reports a failed listing without emptying the page silently', async () => {
    listThreads.mockResolvedValue(err('mailbox unavailable'))

    await useEmailStore.getState().load()

    expect(notifyError).toHaveBeenCalledWith('Could not load your inbox', 'mailbox unavailable')
  })

  it('logs an IPC rejection rather than swallowing it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    getStatus.mockRejectedValue(new Error('bridge gone'))

    await useEmailStore.getState().load()

    expect(logged).toHaveBeenCalled()
    expect(useEmailStore.getState().loaded).toBe(true)
    logged.mockRestore()
  })
})

describe('loadMore', () => {
  beforeEach(() => {
    useEmailStore.setState({ hasMore: true })
  })

  it('asks for another page', async () => {
    listThreads.mockResolvedValue(ok(threads(20)))

    await useEmailStore.getState().loadMore()

    expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ limit: 40 }))
    expect(useEmailStore.getState().loadingMore).toBe(false)
  })

  /**
   * The regression. `loadingMore` was only cleared on `load`'s success path,
   * and `load` has four other exits. The flag is both this action's own guard
   * and the button's `disabled`, so one failure left "Load more" dead for the
   * rest of the session, reading "Loading…".
   */
  it('recovers when the load fails outright', async () => {
    getStatus.mockResolvedValue(err())

    await useEmailStore.getState().loadMore()

    expect(useEmailStore.getState().loadingMore).toBe(false)
  })

  it('recovers when the account has nothing connected', async () => {
    getStatus.mockResolvedValue(ok({ connected: false, accounts: [] }))

    await useEmailStore.getState().loadMore()

    expect(useEmailStore.getState().loadingMore).toBe(false)
  })

  it('recovers when a newer load supersedes it', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    getStatus.mockImplementationOnce(async () => {
      await gate
      return connected()
    })

    const pending = useEmailStore.getState().loadMore()
    // A second listing starts while the first is still waiting on status.
    const newer = useEmailStore.getState().load()
    release()
    await Promise.all([pending, newer])

    expect(useEmailStore.getState().loadingMore).toBe(false)
  })

  it('does nothing when there is no more to fetch', async () => {
    useEmailStore.setState({ hasMore: false })

    await useEmailStore.getState().loadMore()

    expect(listThreads).not.toHaveBeenCalled()
  })
})

describe('openThread and closeThread', () => {
  it('loads the conversation and marks an unread thread read', async () => {
    getThreadMessages.mockResolvedValue(ok([{ id: 'm1' }]))
    applyFlag.mockResolvedValue(ok('Marked as read'))

    await useEmailStore.getState().openThread(thread({ unread: true }))

    expect(useEmailStore.getState().openMessages).toHaveLength(1)
    expect(useEmailStore.getState().openLoading).toBe(false)
    expect(applyFlag).toHaveBeenCalledWith(expect.objectContaining({ action: 'mark_read' }))
  })

  it('leaves an already-read thread alone', async () => {
    getThreadMessages.mockResolvedValue(ok([{ id: 'm1' }]))

    await useEmailStore.getState().openThread(thread({ unread: false }))

    expect(applyFlag).not.toHaveBeenCalled()
  })

  // Closing used not to bump the revision, so a fetch still in flight wrote its
  // messages into a store with no thread open — and the next open briefly
  // showed the previous conversation's mail.
  it('discards a fetch that lands after the pane was closed', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    getThreadMessages.mockImplementation(async () => {
      await gate
      return ok([{ id: 'stale' }])
    })

    const opening = useEmailStore.getState().openThread(thread())
    useEmailStore.getState().closeThread()
    release()
    await opening

    expect(useEmailStore.getState().openMessages).toEqual([])
    expect(useEmailStore.getState().openThreadId).toBeNull()
  })
})

describe('applyFlag', () => {
  it('patches the row in place for a flag that leaves it listed', async () => {
    useEmailStore.setState({ threads: [thread({ id: 't1', starred: false })] })
    applyFlag.mockResolvedValue(ok('Starred'))
    getUnreadThreadCount.mockResolvedValue(ok(2))

    await useEmailStore.getState().applyFlag(thread({ id: 't1' }), 'star')

    expect(useEmailStore.getState().threads[0].starred).toBe(true)
    expect(useEmailStore.getState().unreadCount).toBe(2)
    expect(useEmailStore.getState().busyThreadId).toBeNull()
  })

  it('reloads after archiving, since the row should no longer be listed', async () => {
    useEmailStore.setState({ threads: [thread({ id: 't1' })], openThreadId: 't1' })
    applyFlag.mockResolvedValue(ok('Archived'))

    await useEmailStore.getState().applyFlag(thread({ id: 't1' }), 'archive')

    expect(listThreads).toHaveBeenCalled()
    expect(useEmailStore.getState().openThreadId).toBeNull()
  })

  it('clears the busy marker when the call fails', async () => {
    applyFlag.mockResolvedValue(err('no such thread'))

    await useEmailStore.getState().applyFlag(thread(), 'star')

    expect(useEmailStore.getState().busyThreadId).toBeNull()
    expect(notifyError).toHaveBeenCalled()
  })
})

describe('loadDigests', () => {
  it('fills in digests and stops once nothing is pending', async () => {
    useEmailStore.setState({ threads: [thread({ id: 't1' })] })
    digestThreads.mockResolvedValue(
      ok({
        digests: [{ threadId: 't1', digest: 'A summary' }],
        outcome: 'ok',
        abandonedThreadIds: []
      })
    )

    await useEmailStore.getState().loadDigests()

    expect(useEmailStore.getState().digests).toEqual({ t1: 'A summary' })
    expect(useEmailStore.getState().digesting).toBe(false)
    expect(digestThreads).toHaveBeenCalledTimes(1)
  })

  it('remembers what was abandoned so it is not asked for again', async () => {
    useEmailStore.setState({ threads: [thread({ id: 't1', latestMessageId: 'm1' })] })
    digestThreads.mockResolvedValue(ok({ digests: [], outcome: 'ok', abandonedThreadIds: ['t1'] }))

    await useEmailStore.getState().loadDigests()

    expect(useEmailStore.getState().undigestable).toEqual({ t1: 'm1' })
    expect(digestThreads).toHaveBeenCalledTimes(1)
  })

  it('records why a pass stopped short without calling a loading model a fault', async () => {
    useEmailStore.setState({ threads: [thread({ id: 't1' })] })
    digestThreads.mockResolvedValue(
      ok({ digests: [], outcome: 'engine-unavailable', abandonedThreadIds: [] })
    )

    await useEmailStore.getState().loadDigests()

    expect(useEmailStore.getState().digestBlocked).toBe('engine-unavailable')
  })

  /**
   * The loop's only progress guarantee used to be "the reply mentioned
   * something". A reply naming only threads outside the current listing left
   * `pending` unchanged and satisfied that check, so the identical request went
   * out forever. Progress is now measured against what was actually asked for.
   */
  it('stops when a pass resolves none of the threads it asked about', async () => {
    useEmailStore.setState({ threads: [thread({ id: 't1' })] })
    digestThreads.mockResolvedValue(
      ok({
        digests: [{ threadId: 'not-listed', digest: 'stray' }],
        outcome: 'ok',
        abandonedThreadIds: []
      })
    )

    await useEmailStore.getState().loadDigests()

    expect(digestThreads).toHaveBeenCalledTimes(1)
    expect(useEmailStore.getState().digesting).toBe(false)
  })

  it('reports a failed batch', async () => {
    useEmailStore.setState({ threads: [thread({ id: 't1' })] })
    digestThreads.mockResolvedValue(err())

    await useEmailStore.getState().loadDigests()

    expect(useEmailStore.getState().digestBlocked).toBe('failed')
  })
})

/**
 * Sending, which is the one thing on this page that cannot be taken back.
 *
 * The compose window is new and the send path had no coverage at all, so what
 * is pinned here is the handful of decisions that are invisible when right and
 * expensive when wrong: that a reply is threaded onto the conversation it
 * answers, that a failure leaves the message on screen rather than losing it,
 * and that the model's draft lands in the body instead of being sent.
 */
describe('emailStore — sending', () => {
  const draft = {
    to: 'ada@example.com, grace@example.com',
    cc: '',
    subject: 'Quarterly report',
    body: 'The numbers are attached.',
    kind: 'New message',
    inReplyTo: null,
    accountId: 'account-1'
  }

  beforeEach(() => {
    send.mockReset()
    chatSend.mockReset()
    notifyError.mockReset()
    useEmailStore.setState({ ...initialState, composing: null, sending: false, writing: false })
  })

  it('splits the recipients the way people type them', async () => {
    send.mockResolvedValue(ok(undefined))
    useEmailStore.setState({ composing: draft })

    await useEmailStore.getState().sendCompose()

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['ada@example.com', 'grace@example.com'] })
    )
  })

  it('threads a reply onto the conversation it answers', async () => {
    // Without these the message arrives in the recipient's client as an
    // unrelated mail, which is the difference between a conversation and a
    // pile -- and nothing on this screen would look wrong.
    send.mockResolvedValue(ok(undefined))
    useEmailStore.setState({
      composing: {
        ...draft,
        kind: 'Reply',
        inReplyTo: {
          id: 'm1',
          threadId: 't1',
          messageIdHeader: '<original@example.com>',
          references: ['<older@example.com>'],
          provider: 'imap',
          accountId: 'account-1',
          subject: 'Quarterly report',
          from: 'Ada <ada@example.com>',
          to: [],
          cc: [],
          bcc: [],
          date: 0,
          snippet: '',
          body: '',
          attachments: []
        }
      }
    })

    await useEmailStore.getState().sendCompose()

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: '<original@example.com>',
        references: ['<older@example.com>'],
        threadId: 't1'
      })
    )
  })

  it('keeps the window open when the send fails', async () => {
    // A window that closes on click and fails afterwards loses the message
    // *and* tells somebody it was sent, which is the worst of the three
    // outcomes available here.
    send.mockResolvedValue(err('smtp refused'))
    useEmailStore.setState({ composing: draft })

    const went = await useEmailStore.getState().sendCompose()

    expect(went).toBe(false)
    expect(useEmailStore.getState().composing).not.toBeNull()
    expect(notifyError).toHaveBeenCalled()
  })

  it('closes the window once it has gone', async () => {
    send.mockResolvedValue(ok(undefined))
    useEmailStore.setState({ composing: draft })

    const went = await useEmailStore.getState().sendCompose()

    expect(went).toBe(true)
    expect(useEmailStore.getState().composing).toBeNull()
  })

  it('refuses to send an unfinished message', async () => {
    // The button is disabled, so this is the second door: a keyboard, a
    // double-fire, or a future caller that forgets to check.
    useEmailStore.setState({ composing: { ...draft, subject: '' } })

    expect(await useEmailStore.getState().sendCompose()).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('will not send the same message twice', async () => {
    send.mockResolvedValue(ok(undefined))
    useEmailStore.setState({ composing: draft, sending: true })

    expect(await useEmailStore.getState().sendCompose()).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('emailStore — having the model write it', () => {
  const draft = {
    to: 'ada@example.com',
    cc: '',
    subject: 'Lunch',
    body: '',
    kind: 'New message',
    inReplyTo: null,
    accountId: 'account-1'
  }

  beforeEach(() => {
    chatSend.mockReset()
    notifyError.mockReset()
    useEmailStore.setState({ ...initialState, composing: draft, writing: false })
  })

  it('puts what it wrote in the body, and sends nothing', async () => {
    chatSend.mockResolvedValue(ok({ content: 'Tuesday works for me.' }))

    await useEmailStore.getState().writeBody('Say yes to Tuesday.')

    expect(useEmailStore.getState().composing?.body).toBe('Tuesday works for me.')
    expect(send).not.toHaveBeenCalled()
  })

  it('asks as a temporary turn, so a mailbox does not fill the chat list', async () => {
    chatSend.mockResolvedValue(ok({ content: 'Fine.' }))

    await useEmailStore.getState().writeBody('Agree.')

    expect(chatSend).toHaveBeenCalledWith(
      expect.objectContaining({ temporary: true, projectId: null, history: [] })
    )
  })

  it('keeps what was typed when the model answers with nothing', async () => {
    // This writes into a window somebody may already have started, and losing
    // their words to a draft that did not arrive is worse than no draft.
    useEmailStore.setState({ composing: { ...draft, body: 'Half a sentence' } })
    chatSend.mockResolvedValue(ok({ content: '   ' }))

    await useEmailStore.getState().writeBody('Finish this.')

    expect(useEmailStore.getState().composing?.body).toBe('Half a sentence')
    expect(notifyError).toHaveBeenCalled()
  })
})
