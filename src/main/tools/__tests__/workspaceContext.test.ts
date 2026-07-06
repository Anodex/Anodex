import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectMemory } from '@shared/projectMemory.types'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('../../projects/ProjectMemoryStore', () => ({
  projectMemoryStore: { get: getMock }
}))

const { buildWorkspaceContext } = await import('../workspaceContext')

describe('buildWorkspaceContext', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-wsctx-'))
    getMock.mockReset()
    getMock.mockReturnValue({ projectId: 'p1', filesTouched: [], recentSummaries: [] })
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

  it('appends recent activity from project memory when a project is active', () => {
    const memory: ProjectMemory = {
      projectId: 'p1',
      filesTouched: [{ path: 'src/index.ts', action: 'write', at: Date.now() }],
      recentSummaries: [{ conversationId: 'c1', summary: 'Fixed the login bug.', at: Date.now() }]
    }
    getMock.mockReturnValue(memory)

    const context = buildWorkspaceContext(workspace, 'p1')

    expect(context).toContain('Recent activity')
    expect(context).toContain('write: src/index.ts')
    expect(context).toContain('Fixed the login bug.')
  })

  it('omits the activity section when project memory is empty', () => {
    const context = buildWorkspaceContext(workspace, 'p1')
    expect(context).not.toContain('Recent activity')
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
})
