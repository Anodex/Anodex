import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitStatusTool, gitDiffTool } from '../gitTools'
import { createMockContext, createMockDefine } from './test-helpers'

function run(
  command: string,
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error ? ((error.code as number) ?? 1) : 0 })
    })
  })
}

describe('AI git tools', () => {
  let workspace: string
  let gitAvailable = false

  beforeEach(async () => {
    const check = await run('git --version', tmpdir())
    gitAvailable = check.code === 0
    workspace = await mkdtemp(join(tmpdir(), 'anodex-git-'))
    if (gitAvailable) {
      await run('git init', workspace)
      await run('git config user.email "test@anodex.local"', workspace)
      await run('git config user.name "Test"', workspace)
    }
  })

  afterEach(async () => {
    await import('node:fs/promises').then((m) => m.rm(workspace, { recursive: true, force: true }))
  })

  it('reports git status in a repository', async () => {
    if (!gitAvailable) return
    await writeFile(join(workspace, 'tracked.txt'), 'hello')
    await run('git add tracked.txt', workspace)
    await run('git commit -m "initial"', workspace)
    await writeFile(join(workspace, 'new.txt'), 'world')

    const ctx = createMockContext(workspace)
    const tool = gitStatusTool(createMockDefine(), ctx) as unknown as {
      handler: (args: Record<string, never>) => Promise<string>
    }
    const result = await tool.handler({})

    expect(result).toContain('new.txt')
  })

  it('reports git diff for staged changes', async () => {
    if (!gitAvailable) return
    await writeFile(join(workspace, 'change.txt'), 'original')
    await run('git add change.txt', workspace)
    await run('git commit -m "before"', workspace)
    await writeFile(join(workspace, 'change.txt'), 'modified')
    await run('git add change.txt', workspace)

    const ctx = createMockContext(workspace)
    const tool = gitDiffTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { staged?: boolean }) => Promise<string>
    }
    const result = await tool.handler({ staged: true })

    expect(result).toContain('modified')
  })

  it('truncates a very large diff and reports the real total size', async () => {
    if (!gitAvailable) return
    await writeFile(join(workspace, 'change.txt'), 'original\n')
    await run('git add change.txt', workspace)
    await run('git commit -m "before"', workspace)
    // A diff far bigger than the shared 4000-char model-result cap — the
    // large-output analog of the read_file/run_command large-input tests,
    // guarding against the same double-truncation bug this pass found and
    // fixed in git_diff (a redundant, larger inner cap that always got
    // overridden by the outer one anyway, but reported a meaningless
    // intermediate length when it did).
    await writeFile(
      join(workspace, 'change.txt'),
      Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    )

    const ctx = createMockContext(workspace)
    const tool = gitDiffTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { staged?: boolean }) => Promise<string>
    }
    const result = await tool.handler({})

    expect(result.length).toBeLessThan(4250)
    expect(result).toMatch(/truncated: showing the first \d+ of \d+ bytes/)
  })

  it('returns a failure message outside a git repository', async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), 'anodex-nogit-'))
    try {
      const ctx = createMockContext(nonRepo)
      const tool = gitStatusTool(createMockDefine(), ctx) as unknown as {
        handler: (args: Record<string, never>) => Promise<string>
      }
      const result = await tool.handler({})

      expect(result).toContain('failed')
    } finally {
      await import('node:fs/promises').then((m) => m.rm(nonRepo, { recursive: true, force: true }))
    }
  })
})
