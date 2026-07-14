import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectMemory } from '@shared/projectMemory.types'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('../../projects/ProjectMemoryStore', () => ({
  projectMemoryStore: { get: getMock }
}))

const { buildWorkspaceContext, rankRecallEvents, rankTouchedFiles } =
  await import('../workspaceContext')

describe('buildWorkspaceContext', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-wsctx-'))
    getMock.mockReset()
    getMock.mockReturnValue({ projectId: 'p1', filesTouched: [], recentEvents: [] })
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('summarizes name, scripts, top-level tree, and README', async () => {
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({ name: 'demo-app', scripts: { build: 'tsc', test: 'vitest' } })
    )
    await writeFile(join(workspace, 'README.md'), '# Demo App\nA sample project.')
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'index.ts'), 'export const x = 1')

    const context = buildWorkspaceContext(workspace, null)

    expect(context).toContain('demo-app')
    expect(context).toContain('build, test')
    expect(context).toContain('src/')
    expect(context).toContain('Demo App')
  })

  it('ignores build/vcs directories in the tree', async () => {
    await mkdir(join(workspace, 'node_modules'))
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, 'main.py'), 'print(1)')

    const context = buildWorkspaceContext(workspace, null)

    expect(context).toContain('main.py')
    expect(context).not.toContain('node_modules')
    expect(context).not.toContain('.git')
  })

  it('caps the output length', async () => {
    for (let i = 0; i < 500; i++) {
      await writeFile(join(workspace, `file-${i}.txt`), 'x')
    }
    const context = buildWorkspaceContext(workspace, null)
    expect(context.length).toBeLessThanOrEqual(2002)
  })

  it('returns empty string for a missing workspace', () => {
    expect(buildWorkspaceContext(join(workspace, 'does-not-exist'), null)).toBe('')
  })

  it('omits the activity section when no project is active', () => {
    const context = buildWorkspaceContext(workspace, null)
    expect(context).not.toContain('Recent activity')
    expect(getMock).not.toHaveBeenCalled()
  })

  it('appends retrieved project recall from project memory when a project is active', () => {
    const memory: ProjectMemory = {
      projectId: 'p1',
      filesTouched: [{ path: 'src/index.ts', action: 'write', at: Date.now() }],
      recentEvents: [
        {
          conversationId: 'c1',
          messageId: 'm1',
          createdAt: Date.now(),
          changedFiles: ['src/login.ts'],
          successfulTools: ['edit_file'],
          failedTools: [],
          verification: [{ command: 'npm test', status: 'passed' }],
          assistantSummary: 'Fixed the login bug.'
        }
      ]
    }
    getMock.mockReturnValue(memory)

    const context = buildWorkspaceContext(workspace, 'p1', 'index login')

    expect(context).toContain('project recall')
    expect(context).toContain('write: src/index.ts')
    expect(context).toContain('changed src/login.ts')
    expect(context).toContain('ran `npm test` (passed)')
    expect(context).toContain("assistant's own account (unverified): Fixed the login bug.")
  })

  it('retrieves relevant older events ahead of newer unrelated events', () => {
    const memory: ProjectMemory = {
      projectId: 'p1',
      filesTouched: [],
      recentEvents: [
        {
          conversationId: 'c-new',
          messageId: 'm-new',
          createdAt: 30,
          changedFiles: ['src/theme/colors.css'],
          successfulTools: ['edit_file'],
          failedTools: [],
          verification: [],
          assistantSummary: 'Updated button colors and spacing.'
        },
        {
          conversationId: 'c-old',
          messageId: 'm-old',
          createdAt: 10,
          changedFiles: ['src/auth/login.ts'],
          successfulTools: ['edit_file'],
          failedTools: [],
          verification: [],
          assistantSummary: 'Fixed login redirect after authentication.'
        }
      ]
    }
    getMock.mockReturnValue(memory)

    const context = buildWorkspaceContext(workspace, 'p1', 'login authentication still fails')

    expect(context).toContain('Fixed login redirect')
    expect(context).not.toContain('Updated button colors')
  })

  it('omits the activity section when project memory is empty', () => {
    const context = buildWorkspaceContext(workspace, 'p1')
    expect(context).not.toContain('Recent activity')
  })

  it('omits the activity section when nothing in project memory matches the query, instead of injecting unrelated activity', () => {
    const memory: ProjectMemory = {
      projectId: 'p1',
      filesTouched: [{ path: 'src/theme/colors.css', action: 'write', at: Date.now() }],
      recentEvents: [
        {
          conversationId: 'c1',
          messageId: 'm1',
          createdAt: Date.now(),
          changedFiles: ['src/theme/colors.css'],
          successfulTools: ['edit_file'],
          failedTools: [],
          verification: [],
          assistantSummary: 'Updated button colors.'
        }
      ]
    }
    getMock.mockReturnValue(memory)

    const context = buildWorkspaceContext(
      workspace,
      'p1',
      'completely unrelated database migration'
    )

    expect(context).not.toContain('project recall')
    expect(context).not.toContain('colors.css')
  })

  it('includes ANODEX.md notes when present', async () => {
    await writeFile(
      join(workspace, 'ANODEX.md'),
      '# Anodex Notes\n\n## 2026-07-05\n- Uses ESM throughout.\n'
    )

    const context = buildWorkspaceContext(workspace, null)

    expect(context).toContain('Uses ESM throughout.')
  })

  it('omits the notes section when ANODEX.md does not exist', () => {
    const context = buildWorkspaceContext(workspace, null)
    expect(context).not.toContain('ANODEX.md')
  })

  it('includes .anodex/SPEC.md content when present', async () => {
    await mkdir(join(workspace, '.anodex'), { recursive: true })
    await writeFile(
      join(workspace, '.anodex', 'SPEC.md'),
      '# Project spec\n\n## Add dark mode\n\nUsers asked for it.\n'
    )

    const context = buildWorkspaceContext(workspace, null)

    expect(context).toContain('Add dark mode')
    expect(context).toContain('living spec')
  })

  it('omits the spec section when .anodex/SPEC.md does not exist', () => {
    const context = buildWorkspaceContext(workspace, null)
    expect(context).not.toContain('living spec')
  })
})

describe('project-memory retrieval ranking', () => {
  it('ranks touched files by path relevance before recency', () => {
    const memory: ProjectMemory = {
      projectId: 'p1',
      filesTouched: [
        { path: 'src/theme/colors.css', action: 'write', at: 30 },
        { path: 'src/auth/login.ts', action: 'read', at: 10 }
      ],
      recentEvents: []
    }

    expect(rankTouchedFiles(memory, 'login auth bug')[0].path).toBe('src/auth/login.ts')
  })

  it('returns nothing when the query has no lexical overlap — no fallback to recency', () => {
    const memory: ProjectMemory = {
      projectId: 'p1',
      filesTouched: [],
      recentEvents: [
        {
          conversationId: 'old',
          messageId: 'm-old',
          createdAt: 10,
          changedFiles: [],
          successfulTools: [],
          failedTools: [],
          verification: [],
          assistantSummary: 'Older unrelated task.'
        },
        {
          conversationId: 'new',
          messageId: 'm-new',
          createdAt: 30,
          changedFiles: [],
          successfulTools: [],
          failedTools: [],
          verification: [],
          assistantSummary: 'Newer unrelated task.'
        }
      ]
    }

    expect(rankRecallEvents(memory, 'zqxv')).toEqual([])
  })
})
