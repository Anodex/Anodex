import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'

const h = vi.hoisted(() => ({ opened: [] as string[], external: [] as string[] }))

vi.mock('electron', () => ({
  shell: {
    openPath: (path: string) => {
      h.opened.push(path)
      return Promise.resolve('')
    },
    openExternal: (url: string) => {
      h.external.push(url)
      return Promise.resolve()
    }
  }
}))

const { openItemTool } = await import('../openItemTools')
const { createMockContext, createMockDefine } = await import('./test-helpers')

let workspace: string
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'anodex-open-'))
  mkdirSync(join(workspace, 'server'))
  writeFileSync(join(workspace, 'report.pdf'), 'pdf')
  writeFileSync(join(workspace, 'setup.exe'), 'bin')
  writeFileSync(join(workspace, 'run.sh'), '#!/bin/sh')
  h.opened = []
  h.external = []
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

function open(mode: 'ask' | 'full' | 'untethered', root: string | null = workspace) {
  const prompts: ToolConfirmRequest[] = []
  const ctx = {
    ...createMockContext(workspace),
    workspaceRoot: root,
    permissionMode: mode,
    confirm: (request: ToolConfirmRequest) => {
      prompts.push(request)
      return Promise.resolve({ approved: true })
    }
  }
  const tool = openItemTool(createMockDefine(), ctx) as unknown as {
    handler: (args: { target: string }) => Promise<string>
  }
  return { tool, prompts }
}

describe('open_item', () => {
  it('opens a local dev server in the browser, asking only in Ask mode', async () => {
    const asked = open('ask')
    await asked.tool.handler({ target: 'http://localhost:5173/' })
    expect(asked.prompts).toHaveLength(1)

    const quiet = open('untethered')
    await quiet.tool.handler({ target: 'http://localhost:5173/' })
    expect(quiet.prompts).toHaveLength(0)
    expect(h.external).toEqual(['http://localhost:5173/', 'http://localhost:5173/'])
  })

  it('opens folders and documents from the project', async () => {
    const { tool } = open('full')
    await tool.handler({ target: 'server' })
    await tool.handler({ target: 'report.pdf' })
    expect(h.opened).toEqual([join(workspace, 'server'), join(workspace, 'report.pdf')])
  })

  it('never opens a program or a script, whatever the mode', async () => {
    const { tool, prompts } = open('untethered')
    for (const target of ['setup.exe', 'run.sh']) {
      expect(await tool.handler({ target })).toContain('never programs or scripts')
    }
    expect(h.opened).toEqual([])
    expect(prompts).toHaveLength(0)
  })

  it('refuses other schemes and paths outside the project', async () => {
    const { tool } = open('untethered')
    expect(await tool.handler({ target: 'file:///etc/passwd' })).toContain('Only plain http')
    expect(await tool.handler({ target: '../../etc' })).not.toContain('Opened')
    expect(h.opened).toEqual([])
    expect(h.external).toEqual([])
  })

  it('says how to get a folder when no project is open', async () => {
    const { tool } = open('untethered', null)
    expect(await tool.handler({ target: 'server' })).toContain('request_folder_access')
  })
})
