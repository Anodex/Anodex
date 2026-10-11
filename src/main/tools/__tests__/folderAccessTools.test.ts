import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'

const h = vi.hoisted(() => ({
  home: '',
  projects: [] as Array<{ id: string; name: string; folderPath: string; archived?: boolean }>
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'home' ? h.home : join(h.home, name[0].toUpperCase() + name.slice(1))
  }
}))
vi.mock('../../projects/ProjectStore', () => ({
  projectStore: {
    getState: () => ({ projects: h.projects, activeProjectId: null }),
    create: (request: { name: string; folderPath: string }) => {
      const project = { id: `p${h.projects.length + 1}`, ...request }
      h.projects.push(project)
      return project
    }
  }
}))

const { requestFolderAccessTool } = await import('../folderAccessTools')
const { createMockContext, createMockDefine } = await import('./test-helpers')

type Handler = { handler: (args: { path: string; purpose?: string }) => Promise<string> }

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), 'anodex-folder-access-'))
  h.projects = []
})

afterEach(() => {
  rmSync(h.home, { recursive: true, force: true })
})

function tool(mode: 'ask' | 'full' | 'untethered') {
  const confirmations: ToolConfirmRequest[] = []
  const switchProject = vi.fn()
  const abortGeneration = vi.fn()
  const ctx = {
    ...createMockContext(h.home),
    workspaceRoot: null,
    permissionMode: mode,
    switchProject,
    abortGeneration,
    confirm: (request: ToolConfirmRequest) => {
      confirmations.push(request)
      return Promise.resolve({ approved: true })
    }
  }
  const fn = requestFolderAccessTool(createMockDefine(), ctx) as unknown as Handler
  return { fn, confirmations, switchProject, abortGeneration }
}

describe('request_folder_access', () => {
  it('asks in Ask and Edits mode, then makes the folder a project and moves the reply there', async () => {
    for (const mode of ['ask', 'full'] as const) {
      h.projects = []
      const { fn, confirmations, switchProject, abortGeneration } = tool(mode)
      const result = await fn.handler({
        path: 'Desktop/minecraft-server',
        purpose: 'set up the server'
      })

      expect(confirmations).toHaveLength(1)
      expect(confirmations[0].detail).toContain(join(h.home, 'Desktop', 'minecraft-server'))
      expect(existsSync(join(h.home, 'Desktop', 'minecraft-server'))).toBe(true)
      expect(h.projects).toMatchObject([{ name: 'minecraft-server' }])
      expect(switchProject).toHaveBeenCalledWith('p1')
      expect(abortGeneration).toHaveBeenCalledOnce()
      expect(result).toContain('Folder access granted')
    }
  })

  it('goes ahead without asking in Untethered mode', async () => {
    const { fn, confirmations, switchProject } = tool('untethered')
    await fn.handler({ path: '~/games/server' })
    expect(confirmations).toHaveLength(0)
    expect(switchProject).toHaveBeenCalledOnce()
  })

  it('reuses the project that already has the folder', async () => {
    const folder = join(h.home, 'Desktop', 'site')
    h.projects = [{ id: 'existing', name: 'My site', folderPath: folder }]
    const { fn, switchProject } = tool('untethered')
    await fn.handler({ path: folder })
    expect(h.projects).toHaveLength(1)
    expect(switchProject).toHaveBeenCalledWith('existing')
  })

  it('refuses the whole home folder before asking anything', async () => {
    const { fn, confirmations, switchProject } = tool('ask')
    const result = await fn.handler({ path: '~' })
    expect(result).toContain('whole home folder')
    expect(confirmations).toHaveLength(0)
    expect(switchProject).not.toHaveBeenCalled()
  })
})
