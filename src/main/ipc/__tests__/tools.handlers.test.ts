import type { WebContents } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'
import {
  requestToolConfirmation,
  resetToolApprovalStateForTests,
  resolvePendingConfirmationForTests
} from '../tools.handlers'

describe('tool approval handling', () => {
  afterEach(() => resetToolApprovalStateForTests())

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
})

function createSender(): WebContents & { sent: ToolConfirmRequest[] } {
  const sent: ToolConfirmRequest[] = []
  return {
    sent,
    isDestroyed: () => false,
    send: (_channel: string, payload: ToolConfirmRequest) => {
      sent.push(payload)
    }
  } as unknown as WebContents & { sent: ToolConfirmRequest[] }
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
