import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundProcessInfo } from '@shared/process.types'
import type { ToolConfirmRequest } from '@shared/tools.types'

const h = vi.hoisted(() => ({
  copied: [] as string[],
  watched: [] as Array<{ id: string; when: string; message: string }>,
  processes: new Map<string, Partial<BackgroundProcessInfo>>()
}))

vi.mock('electron', () => ({
  clipboard: { writeText: (text: string) => h.copied.push(text) }
}))
vi.mock('../../processes/BackgroundProcessService', () => ({
  backgroundProcessService: { get: (id: string) => h.processes.get(id) }
}))
vi.mock('../../notifications', () => ({
  doneNotices: {
    watchProcess: (id: string, when: string, notice: { message: string }) => {
      h.watched.push({ id, when, message: notice.message })
      return 'watching'
    }
  }
}))

const { copyToClipboardTool, notifyMeWhenDoneTool } = await import('../notifyTools')
const { takeReplyNotice } = await import('../../notifications/replyNotices')
const { createMockContext, createMockDefine } = await import('./test-helpers')

type Handler = (args: Record<string, unknown>) => Promise<string>

function build(factory: typeof copyToClipboardTool, projectId: string | null = 'proj-1') {
  const prompts: ToolConfirmRequest[] = []
  const ctx = {
    ...createMockContext('/work'),
    projectId,
    permissionMode: 'ask' as const,
    confirm: (request: ToolConfirmRequest) => {
      prompts.push(request)
      return Promise.resolve({ approved: true })
    }
  }
  const tool = factory(createMockDefine(), ctx) as unknown as { handler: Handler }
  return { handler: tool.handler, prompts, ctx }
}

beforeEach(() => {
  h.copied = []
  h.watched = []
  h.processes.clear()
})

describe('copy_to_clipboard', () => {
  it('copies without asking, even in Ask mode', async () => {
    const tool = build(copyToClipboardTool)
    const result = await tool.handler({ text: 'npm run dev' })
    expect(h.copied).toEqual(['npm run dev'])
    expect(tool.prompts).toHaveLength(0)
    expect(result).toContain('Copied 11 characters')
  })

  it('refuses empty and enormous text', async () => {
    const tool = build(copyToClipboardTool)
    await tool.handler({ text: '' })
    await tool.handler({ text: 'x'.repeat(1_000_001) })
    expect(h.copied).toEqual([])
  })
})

describe('notify_me_when_done', () => {
  it('registers a notice for this reply, without asking', async () => {
    const tool = build(notifyMeWhenDoneTool)
    await tool.handler({ what: 'reply', message: 'The report', via: ['phone', 'fax'] })
    expect(tool.prompts).toHaveLength(0)
    expect(takeReplyNotice(tool.ctx.messageId)).toEqual({ message: 'The report', via: ['phone'] })
  })

  it("watches this project's process, defaulting to when it exits", async () => {
    h.processes.set('p1', { id: 'p1', projectId: 'proj-1' })
    const tool = build(notifyMeWhenDoneTool)
    await tool.handler({ what: 'process', process_id: 'p1', message: 'The build' })
    expect(h.watched).toEqual([{ id: 'p1', when: 'exits', message: 'The build' }])
  })

  it("will not watch another project's process, or one with no id", async () => {
    h.processes.set('p2', { id: 'p2', projectId: 'other' })
    const tool = build(notifyMeWhenDoneTool)
    const other = await tool.handler({ what: 'process', process_id: 'p2', message: 'It' })
    const none = await tool.handler({ what: 'process', message: 'It' })
    expect(h.watched).toEqual([])
    expect(other).toContain('No background process "p2"')
    expect(none).toContain('process_id')
  })
})
