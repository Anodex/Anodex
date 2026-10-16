import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolConfirmRequest } from '@shared/tools.types'

const h = vi.hoisted(() => ({
  root: '',
  accounts: [] as Array<{ id: string; address: string }>,
  sent: [] as Array<{ to: string[]; attachments?: Array<{ filename: string }> }>,
  paired: 0,
  connected: 0,
  shared: [] as Array<{ name: string; id: string }>
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(h.root, name === 'documents' ? 'Documents' : name) }
}))
vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({ email: { accounts: h.accounts, primaryAccountId: h.accounts[0]?.id ?? null } })
  }
}))
vi.mock('../../remote/RemoteService', () => ({
  remoteService: {
    status: () => ({ pairedDevices: Array.from({ length: h.paired }, (_, i) => ({ id: `p${i}` })) })
  }
}))
vi.mock('../../remote/fileShared', () => ({
  notifyFileShared: (share: { name: string; id: string }) => {
    h.shared.push(share)
    return h.connected
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

const { findMyFilesTool, foundHeading, myFilesTool, sendFileToMeTool } =
  await import('../personalFileTools')
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
  h.paired = 0
  h.connected = 0
  h.shared = []
})
afterEach(() => rmSync(h.root, { recursive: true, force: true }))

function tools(mode: 'ask' | 'untethered', conversationId = 'conv-1') {
  const prompts: ToolConfirmRequest[] = []
  const emitted: ToolCall[] = []
  const ctx = {
    ...createMockContext(h.root),
    emit: (call: ToolCall) => emitted.push(call),
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
      handler: (a: { path: string; to?: 'phone' | 'email' }) => Promise<string>
    },
    prompts,
    emitted
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

  it('records a refused send as failed, so nothing reads "Sent you a file"', async () => {
    // From a phone, "Remind me in 2 minutes to stretch." reached this tool, was
    // refused, and the transcript said a file had been sent.
    const { send, emitted } = tools('untethered')
    await send.handler({ path: 'stretch' })
    expect(emitted.at(-1)?.status).toBe('error')
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
    expect(await send.handler({ path: budget })).toMatch(/no email account is linked/i)
  })
})

/**
 * "Send it to my phone" used to mean email, which is not set up by default. A
 * paired phone now collects the file from this computer.
 */
describe('sending a file to the paired phone', () => {
  it('goes to the phone by default when one is paired, keeping a copy for it', async () => {
    h.paired = 1
    h.connected = 1
    const { find, send, prompts } = tools('untethered')
    await find.handler({ words: 'budget' })
    const result = await send.handler({ path: budget })
    expect(prompts).toHaveLength(0)
    expect(h.sent).toEqual([])
    expect(h.shared.map((share) => share.name)).toEqual(['Friday budget.xlsx'])
    expect(result).toContain('Sent Friday budget.xlsx')
  })

  it('says the file waits when the phone is not connected', async () => {
    h.paired = 1
    const { find, send } = tools('untethered')
    await find.handler({ words: 'budget' })
    expect(await send.handler({ path: budget })).toContain('waiting for their phone')
  })

  it('still emails when asked to', async () => {
    h.paired = 1
    const { find, send } = tools('untethered')
    await find.handler({ words: 'budget' })
    await send.handler({ path: budget, to: 'email' })
    expect(h.sent).toHaveLength(1)
    expect(h.shared).toEqual([])
  })

  it('asks in Ask mode, naming the phone', async () => {
    h.paired = 1
    const { find, send, prompts } = tools('ask')
    await find.handler({ words: 'budget' })
    await send.handler({ path: budget })
    expect(prompts[0].detail).toContain('paired phone')
  })

  it('refuses the phone when none is paired', async () => {
    const { find, send } = tools('untethered')
    await find.handler({ words: 'budget' })
    expect(await send.handler({ path: budget, to: 'phone' })).toContain('No phone is paired')
  })
})

describe('foundHeading', () => {
  it('reports name matches as found', () => {
    expect(foundHeading('budget', [{ matched: 'name' }, { matched: 'contents: "…"' }])).toBe(
      'Found 2 files:'
    )
  })

  it('says a file that only mentions the words is a lead, not the thing asked for', () => {
    // "What does my todo list say?" found a design note mentioning a todo, and
    // the reply called it the person's todo list.
    const heading = foundHeading('todo list', [{ matched: 'contents: "…a todo…"' }])
    expect(heading).toContain('No file is named for "todo list"')
    expect(heading).toContain('rather than calling it theirs')
  })
})

type MyFilesHandler = { handler: (a: Record<string, unknown>) => Promise<string> }

/** my_files over the same find and send tools, as the registry builds it. */
function myFiles(mode: 'ask' | 'untethered', parts: { send?: boolean; open?: boolean } = {}) {
  const prompts: ToolConfirmRequest[] = []
  const emitted: ToolCall[] = []
  const opened: string[] = []
  const ctx = {
    ...createMockContext(h.root),
    emit: (call: ToolCall) => emitted.push(call),
    workspaceRoot: null,
    conversationId: 'conv-1',
    permissionMode: mode,
    confirm: (request: ToolConfirmRequest) => {
      prompts.push(request)
      return Promise.resolve({ approved: true })
    }
  }
  const define = createMockDefine()
  const open = {
    handler: (a: { target: string }) => {
      opened.push(a.target)
      return Promise.resolve(`Opened ${a.target}.`)
    }
  }
  const tool = myFilesTool(define, ctx, {
    find: findMyFilesTool(define, ctx),
    send: parts.send === false ? undefined : sendFileToMeTool(define, ctx),
    open: parts.open === false ? undefined : open
  }) as unknown as MyFilesHandler
  return { tool, prompts, emitted, opened }
}

describe('my_files', () => {
  beforeEach(() => {
    const downloads = join(h.root, 'downloads')
    mkdirSync(downloads)
    writeFileSync(join(downloads, 'E2250044A.pdf'), 'x'.repeat(5_000))
    writeFileSync(join(downloads, 'notes.txt'), 'short')
    writeFileSync(join(downloads, '.hidden'), 'secret')
    mkdirSync(join(downloads, 'old photos'))
  })

  it('finds, the same as find_my_files', async () => {
    const { tool } = myFiles('untethered')
    expect(await tool.handler({ action: 'find', words: 'budget' })).toContain(budget)
  })

  it('lists a folder biggest first, leaving hidden files out', async () => {
    // "What files are in my Downloads folder?" had no tool but the shell.
    const { tool } = myFiles('untethered')
    const listed = await tool.handler({ action: 'list', folder: 'Downloads', sort: 'biggest' })
    expect(listed).toMatch(/^Downloads \(.*\) has 3 items, biggest first:/)
    expect(listed.indexOf('E2250044A.pdf')).toBeLessThan(listed.indexOf('notes.txt'))
    expect(listed).toContain('old photos (folder')
    expect(listed).not.toContain('.hidden')
  })

  it('sends a file by its name alone, finding it first', async () => {
    // "Send E2250044A.pdf from my Downloads folder to my phone." needed two
    // tools in order, and Llama 3.1 8B asked for folder access instead.
    h.paired = 1
    h.connected = 1
    const { tool } = myFiles('untethered')
    const result = await tool.handler({ action: 'send', file: 'E2250044A.pdf' })
    expect(result).toContain('Sent E2250044A.pdf')
    expect(h.shared.map((share) => share.name)).toEqual(['E2250044A.pdf'])
  })

  it('still asks in Ask mode, through send_file_to_me', async () => {
    h.paired = 1
    const { tool, prompts } = myFiles('ask')
    await tool.handler({ action: 'send', file: 'E2250044A.pdf' })
    expect(prompts[0].detail).toContain('paired phone')
  })

  it('sends a file a listing showed, by the name it showed', async () => {
    const { tool } = myFiles('untethered')
    await tool.handler({ action: 'list', folder: 'Downloads' })
    expect(await tool.handler({ action: 'send', file: 'notes.txt', to: 'email' })).toContain(
      'Emailed notes.txt'
    )
  })

  it('opens a file by name, and a web address as it is', async () => {
    const { tool, opened } = myFiles('untethered')
    await tool.handler({ action: 'open', file: 'notes.txt' })
    await tool.handler({ action: 'open', file: 'https://example.com' })
    expect(opened).toEqual([join(h.root, 'downloads', 'notes.txt'), 'https://example.com'])
  })

  it('reaches nothing outside the person’s own folders', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'anodex-outside-'))
    writeFileSync(join(outside, 'keys.txt'), 'secret')
    try {
      const { tool } = myFiles('untethered')
      const result = await tool.handler({ action: 'send', file: join(outside, 'keys.txt') })
      expect(result).toContain('is not in Documents, Desktop, Downloads or OneDrive')
      expect(h.sent).toEqual([])
      expect(h.shared).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('says an action is off when its tool is switched off', async () => {
    const { tool, emitted } = myFiles('untethered', { send: false })
    expect(await tool.handler({ action: 'send', file: 'notes.txt' })).toContain(
      'switched off in Settings'
    )
    expect(emitted.at(-1)?.status).toBe('error')
  })

  it('asks which file when a name matches more than one', async () => {
    writeFileSync(join(h.root, 'Documents', 'notes.txt'), 'other')
    const { tool } = myFiles('untethered')
    expect(await tool.handler({ action: 'send', file: 'notes.txt' })).toContain(
      'More than one file is named "notes.txt"'
    )
    expect(h.sent).toEqual([])
  })
})
