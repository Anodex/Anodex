import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'

const h = vi.hoisted(() => ({
  root: '',
  accounts: [] as Array<{ id: string; address: string }>,
  sent: [] as Array<{ to: string[]; attachments?: Array<{ filename: string }> }>
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(h.root, name === 'documents' ? 'Documents' : name) }
}))
vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({ email: { accounts: h.accounts, primaryAccountId: h.accounts[0]?.id ?? null } })
  }
}))
vi.mock('../../email/EmailService', () => ({
  emailService: {
    send: (request: { to: string[]; attachments?: Array<{ filename: string }> }) => {
      h.sent.push(request)
      return Promise.resolve()
    }
  }
}))

const { findMyFilesTool, sendFileToMeTool } = await import('../personalFileTools')
const { createMockContext, createMockDefine } = await import('./test-helpers')

let budget: string
beforeEach(() => {
  h.root = mkdtempSync(join(tmpdir(), 'anodex-sendfile-'))
  mkdirSync(join(h.root, 'Documents'))
  budget = join(h.root, 'Documents', 'Friday budget.xlsx')
  writeFileSync(budget, 'numbers')
  writeFileSync(join(h.root, 'Documents', 'private.txt'), 'diary')
  h.accounts = [{ id: 'a1', address: 'me@example.com' }]
  h.sent = []
})
afterEach(() => rmSync(h.root, { recursive: true, force: true }))

function tools(mode: 'ask' | 'untethered', conversationId = 'conv-1') {
  const prompts: ToolConfirmRequest[] = []
  const ctx = {
    ...createMockContext(h.root),
    workspaceRoot: null,
    conversationId,
    permissionMode: mode,
    confirm: (request: ToolConfirmRequest) => {
      prompts.push(request)
      return Promise.resolve({ approved: true })
    }
  }
  const define = createMockDefine()
  return {
    find: findMyFilesTool(define, ctx) as unknown as {
      handler: (a: { words: string }) => Promise<string>
    },
    send: sendFileToMeTool(define, ctx) as unknown as {
      handler: (a: { path: string }) => Promise<string>
    },
    prompts
  }
}

describe('finding a file and sending it to the person', () => {
  it('finds the budget, then emails it to their own address without asking in Untethered', async () => {
    const { find, send, prompts } = tools('untethered')
    expect(await find.handler({ words: 'budget' })).toContain(budget)
    const result = await send.handler({ path: budget })
    expect(prompts).toHaveLength(0)
    expect(h.sent).toEqual([expect.objectContaining({ to: ['me@example.com'] })])
    expect(h.sent[0].attachments?.[0].filename).toBe('Friday budget.xlsx')
    expect(result).toContain('Emailed Friday budget.xlsx')
  })

  it('asks first in Ask mode, naming the file and the address', async () => {
    const { find, send, prompts } = tools('ask')
    await find.handler({ words: 'budget' })
    await send.handler({ path: budget })
    expect(prompts[0].detail).toContain('Friday budget.xlsx')
    expect(prompts[0].detail).toContain('me@example.com')
  })

  it('refuses a file the search did not find in this chat', async () => {
    const { send, prompts } = tools('untethered')
    const result = await send.handler({ path: join(h.root, 'Documents', 'private.txt') })
    expect(result).toContain('Only a file find_my_files found')
    expect(prompts).toHaveLength(0)
    expect(h.sent).toEqual([])
  })

  it("does not carry one chat's results into another", async () => {
    await tools('untethered', 'conv-1').find.handler({ words: 'budget' })
    const other = tools('untethered', 'conv-2')
    expect(await other.send.handler({ path: budget })).toContain('Only a file find_my_files found')
  })

  it('says so when no email account is linked', async () => {
    h.accounts = []
    const { find, send } = tools('untethered')
    await find.handler({ words: 'budget' })
    expect(await send.handler({ path: budget })).toContain('No email account is linked')
  })
})
