import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import type { ToolConfirmRequest } from '@shared/tools.types'
import type { ClientChannel } from '../../clients/ClientChannel'
import { attachRemoteClient, detachAllRemoteClients } from '../../clients/clientRegistry'
import {
  CONFIRMATION_TIMEOUT_MS,
  pendingConfirmationCountForTests,
  requestToolConfirmation,
  resetToolApprovalStateForTests,
  resolvePendingConfirmationForTests
} from '../tools.handlers'

describe('tool approval handling', () => {
  afterEach(() => {
    resetToolApprovalStateForTests()
    detachAllRemoteClients()
  })

  it('remembers non-destructive approvals in the main process', async () => {
    const sender = createSender()
    const first = request('safe-1', 'run_command', 'sensitive')

    const firstResult = requestToolConfirmation(sender, first)
    resolvePendingConfirmationForTests(first.id, { approved: true, remember: true })

    await expect(firstResult).resolves.toEqual({ approved: true, remember: true })
    expect(sender.sent).toHaveLength(1)

    const second = request('safe-2', 'run_command', 'sensitive')
    await expect(requestToolConfirmation(sender, second)).resolves.toEqual({ approved: true })
    expect(sender.sent).toHaveLength(1)
  })

  it('does not carry a remembered approval over to a different conversation', async () => {
    const sender = createSender()
    const first = request('safe-1', 'run_command', 'sensitive', 'conversation-a')

    const firstResult = requestToolConfirmation(sender, first)
    resolvePendingConfirmationForTests(first.id, { approved: true, remember: true })
    await firstResult
    expect(sender.sent).toHaveLength(1)

    const otherConversation = request('safe-2', 'run_command', 'sensitive', 'conversation-b')
    const otherResult = requestToolConfirmation(sender, otherConversation)
    expect(sender.sent).toHaveLength(2)
    resolvePendingConfirmationForTests(otherConversation.id, { approved: true })
    await expect(otherResult).resolves.toEqual({ approved: true })
  })

  it('does not skip destructive confirmations even when the tool was remembered', async () => {
    const sender = createSender()
    const remembered = request('safe-1', 'run_command', 'sensitive')

    const rememberedResult = requestToolConfirmation(sender, remembered)
    resolvePendingConfirmationForTests(remembered.id, { approved: true, remember: true })
    await rememberedResult

    const destructive = request('destructive-1', 'run_command', 'destructive')
    const destructiveResult = requestToolConfirmation(sender, destructive)

    expect(sender.sent).toHaveLength(2)
    resolvePendingConfirmationForTests(destructive.id, { approved: true, remember: true })
    await expect(destructiveResult).resolves.toEqual({ approved: true, remember: true })
  })

  it('does not skip a turn-gated confirmation even when the tool was remembered', async () => {
    const sender = createSender()
    const remembered = request('safe-1', 'edit_file', 'sensitive')

    const rememberedResult = requestToolConfirmation(sender, remembered)
    resolvePendingConfirmationForTests(remembered.id, { approved: true, remember: true })
    await rememberedResult
    expect(sender.sent).toHaveLength(1)

    // Same tool, same conversation, remembered — but this one exists
    // specifically because it's the turn's own "first action" checkpoint,
    // which a per-tool remembered approval must not silently satisfy.
    const turnGated = { ...request('safe-2', 'edit_file', 'sensitive'), turnGate: true }
    const turnGatedResult = requestToolConfirmation(sender, turnGated)

    expect(sender.sent).toHaveLength(2)
    resolvePendingConfirmationForTests(turnGated.id, { approved: true })
    await expect(turnGatedResult).resolves.toEqual({ approved: true })
  })

  it('tells the renderer to drop the card when the generation is aborted mid-prompt', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const sender: ClientChannel = {
      id: 'test-client',
      isAlive: () => true,
      send: (channel, payload) => {
        sent.push({ channel, payload })
      }
    }

    const controller = new AbortController()
    const pending = request('will-be-aborted', 'edit_file', 'sensitive')
    const result = requestToolConfirmation(sender, pending, controller.signal)

    controller.abort()

    await expect(result).resolves.toEqual({
      approved: false,
      reason: 'The generation was cancelled.'
    })
    const cancelledMessages = sent.filter((s) => s.channel === IpcChannel.Tools.confirmCancelled)
    expect(cancelledMessages).toEqual([
      { channel: IpcChannel.Tools.confirmCancelled, payload: 'will-be-aborted' }
    ])
  })

  it('shows an approval prompt on the desktop and on a paired phone at once', async () => {
    // An approval is a question to the user, not to a window, and the user may be at either
    // screen. "One paired device" caps phones; it does not make this single-client.
    const desktop = createSender()
    const phone = createSender('phone')
    attachRemoteClient(phone)

    const pending = request('needs-an-answer', 'run_command', 'sensitive')
    const result = requestToolConfirmation(desktop, pending)

    expect(desktop.sent).toHaveLength(1)
    expect(phone.sent).toHaveLength(1)

    // Whichever answers first settles it — here, the phone.
    resolvePendingConfirmationForTests(pending.id, { approved: true })
    await expect(result).resolves.toEqual({ approved: true })
  })

  it('tells the other screen to drop its card once one of them has answered', async () => {
    // Otherwise the desktop is left showing a live-looking prompt whose buttons silently
    // no-op, because the id is already gone from `pendingConfirmations`.
    const desktop = createSender()
    const phone = createSender('phone')
    attachRemoteClient(phone)

    const controller = new AbortController()
    const pending = request('aborted-everywhere', 'edit_file', 'sensitive')
    const result = requestToolConfirmation(desktop, pending, controller.signal)

    controller.abort()
    await result

    for (const client of [desktop, phone]) {
      expect(client.cancelled).toEqual(['aborted-everywhere'])
    }
  })

  it('denies a prompt nobody answers, rather than waiting forever', async () => {
    // A phone that leaves Wi-Fi mid-prompt takes the answer with it. Without a
    // deadline the promise never settles, wedging that generation for the rest of
    // the session on a machine the user may not be near.
    vi.useFakeTimers()
    try {
      const desktop = createSender()
      const result = requestToolConfirmation(
        desktop,
        request('nobody-answers', 'run_command', 'sensitive')
      )

      await vi.advanceTimersByTimeAsync(CONFIRMATION_TIMEOUT_MS + 1000)

      // Denied, not approved: a denied call is a turn the user can retry, whereas
      // an approval nobody gave is not something to invent on their behalf.
      await expect(result).resolves.toMatchObject({ approved: false })
      expect(desktop.cancelled).toEqual(['nobody-answers'])
      expect(pendingConfirmationCountForTests()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an answered prompt does not fire its expiry afterwards', async () => {
    // The timer has to be cleared when the user answers, or every answered prompt
    // leaves a five-minute timer behind and the process cannot exit promptly.
    vi.useFakeTimers()
    try {
      const desktop = createSender()
      const pending = request('answered-in-time', 'edit_file', 'sensitive')
      const result = requestToolConfirmation(desktop, pending)

      resolvePendingConfirmationForTests(pending.id, { approved: true })
      await expect(result).resolves.toEqual({ approved: true })

      await vi.advanceTimersByTimeAsync(CONFIRMATION_TIMEOUT_MS + 1000)

      // No cancellation went out, because there was nothing left to cancel.
      expect(desktop.cancelled).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('denies rather than approves when no client is attached to answer', async () => {
    // An unanswerable prompt must never become an implicit approval.
    const gone: ClientChannel & { sent: ToolConfirmRequest[] } = {
      ...createSender(),
      isAlive: () => false
    }

    await expect(
      requestToolConfirmation(gone, request('nobody-home', 'run_command', 'sensitive'))
    ).resolves.toEqual({ approved: false })
  })

  it('does not send a cancellation message for a request the user already answered', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const sender: ClientChannel = {
      id: 'test-client',
      isAlive: () => true,
      send: (channel, payload) => {
        sent.push({ channel, payload })
      }
    }

    const controller = new AbortController()
    const pending = request('already-answered', 'edit_file', 'sensitive')
    const result = requestToolConfirmation(sender, pending, controller.signal)
    resolvePendingConfirmationForTests(pending.id, { approved: true })
    await result

    controller.abort()

    expect(sent.some((s) => s.channel === IpcChannel.Tools.confirmCancelled)).toBe(false)
  })
})

function createSender(
  id = 'test-client'
): ClientChannel & { sent: ToolConfirmRequest[]; cancelled: string[] } {
  const sent: ToolConfirmRequest[] = []
  const cancelled: string[] = []
  return {
    id,
    sent,
    cancelled,
    isAlive: () => true,
    send: (channel: string, payload: unknown) => {
      if (channel === IpcChannel.Tools.confirmCancelled) cancelled.push(payload as string)
      else sent.push(payload as ToolConfirmRequest)
    }
  }
}

function request(
  id: string,
  toolName: string,
  risk: ToolConfirmRequest['risk'],
  conversationId = 'conversation'
): ToolConfirmRequest {
  return {
    id,
    conversationId,
    messageId: 'message',
    toolName,
    kind: 'command',
    title: 'Run command?',
    detail: 'npm test',
    risk
  }
}
