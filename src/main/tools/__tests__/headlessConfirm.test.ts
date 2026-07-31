import { describe, expect, it } from 'vitest'
import { TOOL_CATALOG, type ToolConfirmRequest, type ToolRisk } from '@shared/tools.types'
import { headlessConfirm } from '../headlessConfirm'

function request(overrides: Partial<ToolConfirmRequest> = {}): ToolConfirmRequest {
  return {
    id: 'confirm-1',
    conversationId: 'c1',
    messageId: 'm1',
    toolName: 'write_file',
    kind: 'write',
    title: 'Write file',
    detail: 'src/app.ts',
    risk: 'safe',
    ...overrides
  }
}

describe('headlessConfirm', () => {
  it('refuses a call that needs a person, and says what to do instead', async () => {
    const response = await headlessConfirm(
      request({ toolName: 'send_email', risk: 'sensitive', requiresHumanApproval: true })
    )
    expect(response.approved).toBe(false)
    // The reason reaches the model as its denial message, so it has to name the
    // alternative rather than just refusing.
    expect(response.reason).toContain('send_email')
    expect(response.reason).toContain('save_email_draft')
  })

  it('refuses destructive calls', async () => {
    const response = await headlessConfirm(request({ risk: 'destructive' }))
    expect(response.approved).toBe(false)
    expect(response.reason).toBeTruthy()
  })

  it('approves ordinary work so unattended runs still get things done', async () => {
    for (const risk of ['trivial', 'safe', 'sensitive'] as ToolRisk[]) {
      await expect(headlessConfirm(request({ risk }))).resolves.toMatchObject({ approved: true })
    }
  })

  it('refuses human-approval calls even at a low risk tier', async () => {
    // The flag is not a risk tier and must not be reachable by lowering one.
    const response = await headlessConfirm(
      request({ risk: 'trivial', requiresHumanApproval: true })
    )
    expect(response.approved).toBe(false)
  })

  it('always settles, so a blocked call fails the step instead of stranding the run', async () => {
    // `ctx.confirm` is awaited; a promise that never resolves would hang the
    // run until its budget expired.
    await expect(
      Promise.race([
        headlessConfirm(request({ requiresHumanApproval: true })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('never settled')), 50))
      ])
    ).resolves.toBeDefined()
  })
})

describe('TOOL_CATALOG human-approval flags', () => {
  it('marks both email send paths, so neither can run unattended', () => {
    const flagged = TOOL_CATALOG.filter((tool) => tool.requiresHumanApproval).map((t) => t.name)
    expect(flagged).toEqual(expect.arrayContaining(['send_email', 'reply_email']))
  })

  it('leaves the read-only email tools available to unattended runs', () => {
    // A scheduled "summarize my inbox" task is the main use case; flagging the
    // whole email surface would break it.
    for (const name of ['list_threads', 'search_email', 'summarize_thread', 'draft_email']) {
      const tool = TOOL_CATALOG.find((entry) => entry.name === name)
      expect(tool?.requiresHumanApproval, name).toBeFalsy()
    }
  })
})
