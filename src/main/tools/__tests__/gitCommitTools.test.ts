import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { gitCommitSummaryTool } from '../gitCommitTools'
import { createMockContext, createMockDefine } from './test-helpers'

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error) => {
      if (error) reject(error instanceof Error ? error : new Error('git command failed'))
      else resolve()
    })
  })
}

async function makeRepo(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'anodex-commit-tool-'))
  await git(['init'], workspace)
  await git(['config', 'user.email', 'test@anodex.local'], workspace)
  await git(['config', 'user.name', 'Anodex Test'], workspace)
  await writeFile(join(workspace, 'README.md'), '# Demo\n', 'utf-8')
  await git(['add', '.'], workspace)
  await git(['commit', '-m', 'initial'], workspace)
  return workspace
}

describe('git_commit_summary', () => {
  it('includes staged and untracked files by default', async () => {
    const workspace = await makeRepo()
    try {
      await writeFile(join(workspace, 'README.md'), '# Staged\n', 'utf-8')
      await git(['add', 'README.md'], workspace)
      await writeFile(join(workspace, 'new-file.ts'), 'export const value = 1\n', 'utf-8')
      const tool = gitCommitSummaryTool(
        createMockDefine(),
        createMockContext(workspace)
      ) as unknown as { handler: (args: unknown) => Promise<string> }

      const result = await tool.handler({})

      expect(result).toContain('README.md')
      expect(result).toContain('new-file.ts')
      expect(result).toContain('Files changed: 2')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('suggests a commit message from changed files and diff stats', async () => {
    const workspace = await makeRepo()
    try {
      await writeFile(join(workspace, 'README.md'), '# Demo\n\nMore docs.\n', 'utf-8')
      const ctx = createMockContext(workspace)
      const tool = gitCommitSummaryTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      const result = await tool.handler({})

      expect(result).toContain('Suggested commit message')
      expect(result).toContain('docs: update project documentation')
      expect(result).toContain('README.md')
      expect(result).toContain('Files changed: 1')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
