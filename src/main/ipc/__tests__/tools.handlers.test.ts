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
  risk: ToolConfirmRequest['risk']
): ToolConfirmRequest {
  return {
    id,
    conversationId: 'conversation',
    messageId: 'message',
    toolName,
    kind: 'command',
    title: 'Run command?',
    detail: 'npm test',
    risk
  }
}
