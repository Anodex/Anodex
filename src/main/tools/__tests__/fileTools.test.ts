import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileTouchAction } from '@shared/projectMemory.types'
import { createDirectoryTool, deleteDirectoryTool } from '../directoryTools'
import { deleteFileTool, moveFileTool } from '../mutationTools'
import {
  getFileInfoTool,
  listDirectoryTool,
  readFileTool,
  readFileRangeTool,
  readMultipleFilesTool,
  searchFilesTool
} from '../fileTools'
import {
  captureCalls,
  captureConfirmations,
  createMockContext,
  createMockDefine
} from './test-helpers'

const recordTouchMock = vi.fn<(projectId: string, path: string, action: FileTouchAction) => void>()

vi.mock('../../projects/ProjectMemoryStore', () => ({
  projectMemoryStore: {
    recordTouch: (projectId: string, path: string, action: FileTouchAction) =>
      recordTouchMock(projectId, path, action)
  }
}))

describe('AI file tools', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-tools-'))
    recordTouchMock.mockReset()
  })

  afterEach(async () => {
    await import('node:fs/promises').then((m) => m.rm(workspace, { recursive: true, force: true }))
  })

  describe('list_directory', () => {
    it('lists files and folders, folders first, alphabetical within each group', async () => {
      await writeFile(join(workspace, 'b.txt'), 'x')
      await writeFile(join(workspace, 'a.txt'), 'x')
      await mkdir(join(workspace, 'zdir'))
      const ctx = createMockContext(workspace)
      const tool = listDirectoryTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path?: string }) => Promise<string>
      }

      const result = await tool.handler({})

      const lines = result.split('\n').slice(1)
      expect(lines[0]).toBe('zdir/')
      expect(lines[1]).toContain('a.txt')
      expect(lines[2]).toContain('b.txt')
    })

    it('reports an empty directory', async () => {
      const ctx = createMockContext(workspace)
      const tool = listDirectoryTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path?: string }) => Promise<string>
      }

      const result = await tool.handler({})

      expect(result).toContain('(empty)')
    })

    it('caps a very large directory listing at 300 entries with an overflow note', async () => {
      // Short directory names (no "(N bytes)" suffix) keep the whole listing
      // under the shared 4000-char model-result cap in `runReadTool`, so the
      // entry cap's own overflow note is actually observable here rather than
      // being sliced away by that separate, lower-level truncation layer.
      await Promise.all(
        Array.from({ length: 350 }, (_, i) =>
          mkdir(join(workspace, `d${String(i).padStart(4, '0')}`))
        )
      )
      const ctx = createMockContext(workspace)
      const tool = listDirectoryTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path?: string }) => Promise<string>
      }

      const result = await tool.handler({})

      expect(result).toContain('… 50 more')
      expect(result.split('\n').filter((l) => l.endsWith('/'))).toHaveLength(300)
    })

    it('reports the true total entry count even when the listing itself is capped', async () => {
      const capture = captureCalls()
      await Promise.all(
        Array.from({ length: 350 }, (_, i) =>
          mkdir(join(workspace, `d${String(i).padStart(4, '0')}`))
        )
      )
      const ctx = { ...createMockContext(workspace), emit: capture.emit }
      const tool = listDirectoryTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path?: string }) => Promise<string>
      }

      await tool.handler({})

      const success = capture.calls.find((c) => c.status === 'success')
      expect(success?.detail).toBe('350 entries')
    })
  })

  describe('read_file', () => {
    it('reads a text file', async () => {
      await writeFile(join(workspace, 'a.txt'), 'hello world')
      const ctx = createMockContext(workspace)
      const tool = readFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'a.txt' })

      expect(result).toBe('hello world')
    })

    it('truncates a large file and reports the real original size, not an intermediate one', async () => {
      const big = 'x'.repeat(70_000)
      await writeFile(join(workspace, 'big.txt'), big)
      const ctx = createMockContext(workspace)
      const tool = readFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'big.txt' })

      // Truncation is handled once, by the shared `runReadTool` cap that every
      // read tool goes through — read_file must not also truncate internally,
      // since a second, smaller truncation layered on top of the first would
      // report a meaningless intermediate length instead of the file's real
      // size (a real bug this test caught: read_file used to slice at 60KB
      // with its own note, which the shared 4000-char cap then re-truncated,
      // burying the real size and reporting the intermediate string's length
      // instead).
      expect(result.length).toBeLessThan(big.length)
      expect(result).toContain('truncated, 70000 bytes total')
    })

    it('rejects a directory path', async () => {
      await mkdir(join(workspace, 'adir'))
      const ctx = createMockContext(workspace)
      const tool = readFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'adir' })

      expect(result).toContain('not a file')
    })
  })

  describe('search_files', () => {
    it('finds matches case-insensitively and reports file:line', async () => {
      await writeFile(join(workspace, 'a.txt'), 'Hello World\nsecond line')
      const ctx = createMockContext(workspace)
      const tool = searchFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { query: string; path?: string }) => Promise<string>
      }

      const result = await tool.handler({ query: 'hello' })

      expect(result).toContain('a.txt:1:')
    })

    it('scopes the search to a subdirectory when given', async () => {
      await mkdir(join(workspace, 'sub'))
      await writeFile(join(workspace, 'root.txt'), 'needle')
      await writeFile(join(workspace, 'sub', 'nested.txt'), 'needle')
      const ctx = createMockContext(workspace)
      const tool = searchFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { query: string; path?: string }) => Promise<string>
      }

      const result = await tool.handler({ query: 'needle', path: 'sub' })

      expect(result).toContain('nested.txt')
      expect(result).not.toContain('root.txt')
    })

    it('reports no matches found', async () => {
      await writeFile(join(workspace, 'a.txt'), 'nothing relevant here')
      const ctx = createMockContext(workspace)
      const tool = searchFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { query: string; path?: string }) => Promise<string>
      }

      const result = await tool.handler({ query: 'zzznomatch' })

      expect(result).toContain('No matches found')
    })

    it('caps results at 100 matches with an overflow note on a file with many hits', async () => {
      const manyLines = Array.from({ length: 150 }, () => 'needle here').join('\n')
      await writeFile(join(workspace, 'big.txt'), manyLines)
      const ctx = createMockContext(workspace)
      const tool = searchFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { query: string; path?: string }) => Promise<string>
      }

      const result = await tool.handler({ query: 'needle' })

      expect(result).toContain('50 more matches')
    })
  })

  describe('create_directory', () => {
    it('creates a nested directory without asking for approval', async () => {
      const { calls, emit } = captureCalls()
      const { requests, confirm } = captureConfirmations()
      const ctx = { ...createMockContext(workspace), emit, confirm }
      const tool = createDirectoryTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'src/components' })

      expect(result).toContain('src/components')
      expect(calls.length).toBe(2)
      expect(calls[0].status).toBe('running')
      expect(calls[1].status).toBe('success')
      expect(requests).toHaveLength(0)
    })
  })

  describe('delete_directory', () => {
    it('deletes an empty directory after approval', async () => {
      const target = join(workspace, 'empty-dir')
      await mkdir(target)
      const { requests, confirm } = captureConfirmations()
      const ctx = { ...createMockContext(workspace), confirm }
      const tool = deleteDirectoryTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'empty-dir' })

      expect(result).toContain('Deleted directory')
      expect(requests).toHaveLength(1)
    })
  })

  describe('delete_file', () => {
    it('deletes a file after approval', async () => {
      await writeFile(join(workspace, 'old.txt'), 'delete me')
      const { requests, confirm } = captureConfirmations()
      const ctx = { ...createMockContext(workspace), confirm }
      const tool = deleteFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'old.txt' })

      expect(result).toContain('Deleted old.txt')
      expect(requests).toHaveLength(1)
    })
  })

  describe('move_file', () => {
    it('moves a file after approval', async () => {
      await writeFile(join(workspace, 'a.txt'), 'hello')
      const { requests, confirm } = captureConfirmations()
      const ctx = { ...createMockContext(workspace), confirm }
      const tool = moveFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { sourcePath: string; targetPath: string }) => Promise<string>
      }

      const result = await tool.handler({ sourcePath: 'a.txt', targetPath: 'b.txt' })

      expect(result).toContain('a.txt')
      expect(result).toContain('b.txt')
      expect(requests).toHaveLength(1)
    })
  })

  describe('get_file_info', () => {
    it('returns metadata for a text file', async () => {
      await writeFile(join(workspace, 'sample.txt'), 'line1\nline2\nline3')
      const ctx = createMockContext(workspace)
      const tool = getFileInfoTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'sample.txt' })

      expect(result).toContain('"isFile": true')
      expect(result).toContain('"lineCount": 3')
    })
  })

  describe('read_file_range', () => {
    it('returns the requested 1-indexed line range', async () => {
      await writeFile(join(workspace, 'lines.txt'), 'a\nb\nc\nd\ne')
      const ctx = createMockContext(workspace)
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number; endLine: number }) => Promise<string>
      }

      const result = await tool.handler({ path: 'lines.txt', startLine: 2, endLine: 4 })

      expect(result).toBe('b\nc\nd')
    })

    it('caps the returned range at 200 lines even when endLine asks for far more', async () => {
      const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n')
      await writeFile(join(workspace, 'big.txt'), content)
      const ctx = createMockContext(workspace)
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
      }

      // A wildly oversized endLine (the exact shape of a real observed
      // failure: a model requesting `endLine: 1e15`) must not return
      // everything up to the actual end of file — it should still stop
      // after MAX_RANGE_LINES lines, keeping any single call's context
      // cost bounded regardless of what the model asks for.
      const result = await tool.handler({
        path: 'big.txt',
        startLine: 300,
        endLine: 1_000_000_000_000_000
      })
      const returnedLines = result.split('\n')

      expect(returnedLines).toHaveLength(200)
      expect(returnedLines[0]).toBe('line 300')
      expect(returnedLines[199]).toBe('line 499')
    })

    it('records a read touch in project memory', async () => {
      await writeFile(join(workspace, 'lines.txt'), 'a\nb\nc')
      const ctx = { ...createMockContext(workspace), projectId: 'project-1' }
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number }) => Promise<string>
      }

      await tool.handler({ path: 'lines.txt', startLine: 1 })

      expect(recordTouchMock).toHaveBeenCalledWith('project-1', 'lines.txt', 'read')
    })
  })

  describe('read_multiple_files', () => {
    it('reads several files and reports errors per file', async () => {
      await writeFile(join(workspace, 'one.txt'), 'first')
      await writeFile(join(workspace, 'two.txt'), 'second')
      const ctx = createMockContext(workspace)
      const tool = readMultipleFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { paths: string[] }) => Promise<string>
      }

      const result = await tool.handler({ paths: ['one.txt', 'missing.txt', 'two.txt'] })

      expect(result).toContain('first')
      expect(result).toContain('second')
      expect(result).toContain('Error:')
    })

    it('records a touch for each successfully-read path, but not for a missing one', async () => {
      await writeFile(join(workspace, 'one.txt'), 'first')
      await writeFile(join(workspace, 'two.txt'), 'second')
      const ctx = { ...createMockContext(workspace), projectId: 'project-1' }
      const tool = readMultipleFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { paths: string[] }) => Promise<string>
      }

      await tool.handler({ paths: ['one.txt', 'missing.txt', 'two.txt'] })

      expect(recordTouchMock).toHaveBeenCalledTimes(2)
      expect(recordTouchMock).toHaveBeenCalledWith('project-1', 'one.txt', 'read')
      expect(recordTouchMock).toHaveBeenCalledWith('project-1', 'two.txt', 'read')
    })
  })
})
