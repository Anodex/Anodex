import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'

const h = vi.hoisted(() => ({
  trashed: [] as string[],
  trashError: null as string | null,
  candidates: [] as Array<Record<string, unknown>>
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nowhere' },
  shell: {
    trashItem: (path: string) => {
      if (h.trashError) return Promise.reject(new Error(h.trashError))
      h.trashed.push(path)
      return Promise.resolve()
    }
  }
}))
vi.mock('../../cleanup/cleanupCandidates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../cleanup/cleanupCandidates')>()),
  findCleanupCandidates: () => Promise.resolve(h.candidates)
}))

const { findCleanupTool, moveToTrashTool } = await import('../cleanupTools')
const { createMockContext, createMockDefine } = await import('./test-helpers')

let workspace: string
let cacheDir: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'anodex-trash-'))
  cacheDir = join(workspace, '..', `npm-cache-${Date.now()}`)
  mkdirSync(cacheDir, { recursive: true })
  h.trashed = []
  h.trashError = null
  h.candidates = [
    {
      id: 'npm-cache',
      label: 'npm cache',
      why: 'rebuilds',
      where: cacheDir,
      paths: [cacheDir],
      sizeBytes: 2_100_000_000,
      atLeast: false
    },
    {
      id: 'old-downloads',
      label: 'Downloads older than a year',
      why: 'old',
      where: '/dl',
      paths: [],
      sizeBytes: 400_000_000,
      atLeast: false
    }
  ]
})
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(cacheDir, { recursive: true, force: true })
})

function trash(mode: 'ask' | 'untethered', answer: ToolConfirmResponse = { approved: true }) {
  const prompts: ToolConfirmRequest[] = []
  const ctx = {
    ...createMockContext(workspace),
    permissionMode: mode,
    confirm: (request: ToolConfirmRequest) => {
      prompts.push(request)
      return Promise.resolve(answer)
    }
  }
  const tool = moveToTrashTool(createMockDefine(), ctx) as unknown as {
    handler: (args: { items: string[] }) => Promise<string>
  }
  return { tool, prompts }
}

describe('find_cleanup', () => {
  it('lists what can go with sizes and ids, and never asks', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.reject(new Error('asked'))
    }
    const tool = findCleanupTool(createMockDefine(), ctx) as unknown as {
      handler: () => Promise<string>
    }
    const result = await tool.handler()
    expect(result).toContain('npm-cache: npm cache, 2.0 GB')
    expect(result).toContain('moves them to the Trash')
  })
})

describe('move_to_trash', () => {
  it('shows a list to tick in Ask mode, and moves only what stayed ticked', async () => {
    const { tool, prompts } = trash('ask', { approved: true, chosenIds: ['npm-cache'] })
    const result = await tool.handler({ items: ['npm-cache', 'old-downloads'] })
    expect(prompts[0].choices?.map((choice) => choice.id)).toEqual(['npm-cache', 'old-downloads'])
    expect(h.trashed).toEqual([cacheDir])
    expect(result).toContain('Moved to the Trash (2.0 GB): npm cache')
  })

  it('moves everything without asking in Untethered mode', async () => {
    const { tool, prompts } = trash('untethered')
    await tool.handler({ items: ['npm-cache'] })
    expect(prompts).toHaveLength(0)
    expect(h.trashed).toEqual([cacheDir])
  })

  it('moves files inside the open project by path', async () => {
    writeFileSync(join(workspace, 'build.log'), 'x'.repeat(100))
    const { tool } = trash('untethered')
    await tool.handler({ items: ['build.log'] })
    expect(h.trashed).toEqual([join(workspace, 'build.log')])
  })

  it('refuses anything else before asking: an unknown id, or a path outside the project', async () => {
    for (const items of [['steam-library'], ['../../etc/passwd'], ['.']]) {
      const { tool, prompts } = trash('ask')
      const result = await tool.handler({ items })
      expect(prompts).toHaveLength(0)
      expect(result).not.toContain('Moved')
    }
    expect(h.trashed).toEqual([])
  })

  it('reports a failed move and never deletes instead', async () => {
    h.trashError = 'No trash can on this file system'
    const { tool } = trash('untethered')
    const result = await tool.handler({ items: ['npm-cache'] })
    expect(result).toContain('Could not move: npm cache: No trash can on this file system')
    expect(result).toContain('Nothing was deleted instead')
  })
})
