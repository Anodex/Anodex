import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'

/**
 * First coverage for the store that owns toasts and the tool-approval queue.
 * Both matter more than they look: a toast is how every background failure
 * reaches the user, and the queue is what stands between a model's write and
 * the person approving it.
 */

const respondConfirmation = vi.fn<(id: string, response: unknown) => Promise<unknown>>()
const playChime = vi.fn<(kind: string) => void>()
const notifyDesktop = vi.fn<(title: string, message: string) => void>()
const logDiagnostic = vi.fn()

vi.mock('../../lib/anodex', () => ({
  anodex: { tools: { respondConfirmation } }
}))
vi.mock('../../lib/sound', () => ({ playChime }))
vi.mock('../../lib/notifications', () => ({ notifyDesktop }))
vi.mock('../diagnosticsStore', () => ({ logDiagnostic }))

const { useUiStore, notifyError } = await import('../uiStore')
const initialState = useUiStore.getState()

function confirmRequest(id: string): ToolConfirmRequest {
  return {
    id,
    conversationId: 'c1',
    messageId: 'm1',
    toolName: 'write_file',
    kind: 'write',
    title: `Write ${id}.ts`,
    detail: 'contents',
    risk: 'safe'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  useUiStore.setState(initialState, true)
  respondConfirmation.mockResolvedValue(undefined)
})

describe('toast repeats and holding', () => {
  it('counts a repeat instead of stacking a copy, and restarts its time', () => {
    vi.useFakeTimers()
    useUiStore.getState().notify({ kind: 'error', title: 'Offline', message: 'No route' })
    vi.advanceTimersByTime(5000)
    useUiStore.getState().notify({ kind: 'error', title: 'Offline', message: 'No route' })

    const toasts = useUiStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].count).toBe(2)
    vi.advanceTimersByTime(5000)
    expect(useUiStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(useUiStore.getState().toasts).toHaveLength(0)
  })

  it('does not chime again for a repeat', () => {
    useUiStore.getState().notify({ kind: 'error', title: 'Offline' })
    useUiStore.getState().notify({ kind: 'error', title: 'Offline' })
    expect(playChime).toHaveBeenCalledTimes(1)
  })

  it('holds every countdown while the stack is read, and resumes from where it stopped', () => {
    vi.useFakeTimers()
    useUiStore.getState().notify({ kind: 'success', title: 'Saved' })
    vi.advanceTimersByTime(3000)

    useUiStore.getState().holdToasts(true)
    vi.advanceTimersByTime(60_000)
    expect(useUiStore.getState().toasts).toHaveLength(1)

    useUiStore.getState().holdToasts(false)
    vi.advanceTimersByTime(900)
    expect(useUiStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(100)
    expect(useUiStore.getState().toasts).toHaveLength(0)
  })

  it('stops a dismissed toast from coming back through its timer', () => {
    vi.useFakeTimers()
    useUiStore.getState().notify({ kind: 'success', title: 'Saved' })
    const { id } = useUiStore.getState().toasts[0]
    useUiStore.getState().dismissToast(id)
    useUiStore.getState().notify({ kind: 'success', title: 'Saved' })
    vi.advanceTimersByTime(3999)
    expect(useUiStore.getState().toasts).toHaveLength(1)
  })
})

describe('toasts', () => {
  it('shows a toast and clears it once its time is up', () => {
    vi.useFakeTimers()
    useUiStore.getState().notify({ kind: 'success', title: 'Done' })

    expect(useUiStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(4000)
    expect(useUiStore.getState().toasts).toHaveLength(0)
  })

  it('keeps an error up longer than a success', () => {
    vi.useFakeTimers()
    useUiStore.getState().notify({ kind: 'error', title: 'Broke' })

    vi.advanceTimersByTime(4000)
    expect(useUiStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(3000)
    expect(useUiStore.getState().toasts).toHaveLength(0)
  })

  /**
   * `kind === 'error' ? 'error' : 'success'` gave an `info` toast the success
   * chime, so "Nothing to compact" sounded exactly like "Model ready". An info
   * toast is a statement rather than an outcome.
   */
  it('does not celebrate an informational toast', () => {
    useUiStore.getState().notify({ kind: 'info', title: 'Nothing to compact' })

    expect(playChime).not.toHaveBeenCalled()
    expect(notifyDesktop).not.toHaveBeenCalled()
  })

  it('chimes and notifies for a success, and only chimes for an error', () => {
    useUiStore.getState().notify({ kind: 'success', title: 'Model ready', message: 'llama' })
    expect(playChime).toHaveBeenCalledWith('success')
    expect(notifyDesktop).toHaveBeenCalledWith('Model ready', 'llama')

    vi.clearAllMocks()
    useUiStore.getState().notify({ kind: 'error', title: 'Failed' })
    expect(playChime).toHaveBeenCalledWith('error')
    // A desktop notification for a failure the user is already looking at
    // would be a second interruption for one event.
    expect(notifyDesktop).not.toHaveBeenCalled()
  })

  it('leaves a pending toast up, silently, until it is resolved', () => {
    vi.useFakeTimers()
    const id = useUiStore.getState().notifyPending('Running task')

    vi.advanceTimersByTime(60_000)
    expect(useUiStore.getState().toasts).toHaveLength(1)
    expect(playChime).not.toHaveBeenCalled()

    useUiStore.getState().resolveToast(id, { kind: 'success', title: 'Task finished' })
    expect(useUiStore.getState().toasts[0]).toMatchObject({ id, title: 'Task finished' })
    vi.advanceTimersByTime(4000)
    expect(useUiStore.getState().toasts).toHaveLength(0)
  })

  it('ignores a resolve for a toast that was already dismissed', () => {
    const id = useUiStore.getState().notifyPending('Running task')
    useUiStore.getState().dismissToast(id)

    useUiStore.getState().resolveToast(id, { kind: 'success', title: 'Too late' })

    expect(useUiStore.getState().toasts).toHaveLength(0)
    expect(playChime).not.toHaveBeenCalled()
  })

  it('records an error toast in diagnostics as well as on screen', () => {
    notifyError('Could not save', 'disk full')

    expect(useUiStore.getState().toasts[0]).toMatchObject({
      kind: 'error',
      title: 'Could not save'
    })
    expect(logDiagnostic).toHaveBeenCalledWith('error', 'runtime', 'Could not save', 'disk full')
  })
})

describe('tool approvals', () => {
  it('queues more than one, since a turn can raise several at once', () => {
    useUiStore.getState().addPendingConfirmation(confirmRequest('a'))
    useUiStore.getState().addPendingConfirmation(confirmRequest('b'))

    expect(useUiStore.getState().pendingConfirmations.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('answers main and drops the card', () => {
    useUiStore.getState().addPendingConfirmation(confirmRequest('a'))

    useUiStore.getState().resolveConfirmation('a', { approved: true })

    expect(respondConfirmation).toHaveBeenCalledWith('a', { approved: true })
    expect(useUiStore.getState().pendingConfirmations).toEqual([])
  })

  it('ignores an answer to a card that is no longer pending', () => {
    useUiStore.getState().resolveConfirmation('gone', { approved: true })

    expect(respondConfirmation).not.toHaveBeenCalled()
  })

  /**
   * A rejection here means the main process never heard the decision and the
   * tool call is still waiting on it. This was a bare `void`, so the turn sat
   * blocked with nothing on screen to say why.
   */
  it('says so when the decision could not be delivered', async () => {
    respondConfirmation.mockRejectedValue(new Error('bridge closed'))
    useUiStore.getState().addPendingConfirmation(confirmRequest('a'))

    useUiStore.getState().resolveConfirmation('a', { approved: true })
    await vi.waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1))

    expect(useUiStore.getState().toasts[0]).toMatchObject({
      kind: 'error',
      title: 'Could not send that decision'
    })
  })

  // Main settled it itself — answering again would be a no-op there, and
  // routing it through `resolveConfirmation` would leave a stale card that
  // silently does nothing when clicked.
  it('drops a cancelled confirmation without answering main', () => {
    useUiStore.getState().addPendingConfirmation(confirmRequest('a'))

    useUiStore.getState().dismissCancelledConfirmation('a')

    expect(useUiStore.getState().pendingConfirmations).toEqual([])
    expect(respondConfirmation).not.toHaveBeenCalled()
  })
})

describe('navigation markers', () => {
  it('only ever moves a seen marker forward', () => {
    // Markers start at "now" so a fresh install has no unread badges to clear,
    // which is why these are relative rather than small absolute numbers.
    const start = useUiStore.getState().navigationSeenAt.agent
    useUiStore.getState().markNavigationSeen('agent', start + 5000)
    useUiStore.getState().markNavigationSeen('agent', start + 1000)

    expect(useUiStore.getState().navigationSeenAt.agent).toBe(start + 5000)
  })

  it('ignores an update older than what has already been seen', () => {
    const start = useUiStore.getState().navigationSeenAt.scheduler

    useUiStore.getState().markNavigationSeen('scheduler', start - 1000)

    expect(useUiStore.getState().navigationSeenAt.scheduler).toBe(start)
  })

  it('marks a conversation unread just behind its own update', () => {
    useUiStore.getState().markConversationUnread('c1', 5000)

    expect(useUiStore.getState().readConversationAt.c1).toBe(4999)
  })
})
