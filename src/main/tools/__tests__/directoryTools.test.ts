import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDirectoryTool, deleteDirectoryTool } from '../directoryTools'
import { createMockContext, createMockDefine } from './test-helpers'

describe('create_directory', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-mkdir-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('creates a directory', async () => {
    const ctx = createMockContext(workspace)
    const tool = createDirectoryTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'new-dir' })

    expect(result).toContain('Created directory')
    const stats = await import('node:fs/promises').then((m) => m.stat(join(workspace, 'new-dir')))
    expect(stats.isDirectory()).toBe(true)
  })

  it('creates parent directories recursively', async () => {
    const ctx = createMockContext(workspace)
    const tool = createDirectoryTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'a/deeply/nested/dir' })

    expect(result).toContain('Created directory')
    const stats = await import('node:fs/promises').then((m) =>
      m.stat(join(workspace, 'a/deeply/nested/dir'))
    )
    expect(stats.isDirectory()).toBe(true)
  })

  it('succeeds when the directory already exists', async () => {
    await mkdir(join(workspace, 'existing'), { recursive: true })
    const ctx = createMockContext(workspace)
    const tool = createDirectoryTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'existing' })

    expect(result).toContain('Created directory')
  })

  it('rejects paths that escape the workspace', async () => {
    const ctx = createMockContext(workspace)
    const tool = createDirectoryTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: '../outside' })
    expect(result).toContain('outside the workspace')
  })
})

describe('delete_directory', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-rmdir-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('deletes an empty directory', async () => {
    await mkdir(join(workspace, 'empty-dir'))
    const ctx = createMockContext(workspace)
    const tool = deleteDirectoryTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'empty-dir' })

    expect(result).toContain('Deleted directory')
    await expect(
      import('node:fs/promises').then((m) => m.stat(join(workspace, 'empty-dir')))
    ).rejects.toThrow(/ENOENT/)
  })

  it('fails on a non-empty directory', async () => {
    await mkdir(join(workspace, 'not-empty'))
    await writeFile(join(workspace, 'not-empty', 'file.txt'), 'content')
    const ctx = createMockContext(workspace)
    const tool = deleteDirectoryTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'not-empty' })

    expect(result).toContain('not empty')
  })

  it('fails on a non-existent path', async () => {
    const ctx = createMockContext(workspace)
    const tool = deleteDirectoryTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'no-such-dir' })

    expect(result).toContain('ENOENT')
  })

  it('rejects paths that escape the workspace', async () => {
    const ctx = createMockContext(workspace)
    const tool = deleteDirectoryTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: '../outside' })
    expect(result).toContain('outside the workspace')
  })
})
