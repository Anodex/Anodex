import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileTouchAction } from '@shared/projectMemory.types'
import { createDirectoryTool, deleteDirectoryTool } from '../directoryTools'
import { deleteFileTool, moveFileTool } from '../mutationTools'
import {
  getFileInfoTool,
  findFilesTool,
  listDirectoryTool,
  readFileTool,
  readFileRangeTool,
  readMultipleFilesTool,
  searchFilesTool
} from '../fileTools'
import { previewHtmlTool } from '../previewTools'
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

    it('returns real content unchanged for a file within the disk cap but over the generic 4000-char default', async () => {
      // A real source file this size used to get silently cut off under the
      // generic 4000-char cap alone — read_file's own modelResultCap exists
      // precisely so this still comes back whole.
      const content = 'x'.repeat(10_000)
      await writeFile(join(workspace, 'medium.txt'), content)
      const ctx = createMockContext(workspace)
      const tool = readFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'medium.txt' })

      expect(result).toBe(content)
    })

    it('recommends targeted tools instead of a truncated blob for a file too large for the active context', async () => {
      const big = 'x'.repeat(70_000)
      await writeFile(join(workspace, 'big.txt'), big)
      const ctx = createMockContext(workspace)
      const tool = readFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'big.txt' })

      // A silently truncated blob reads as complete to the model and invites
      // an edit_file/patch_file call against text it never actually saw — an
      // honest "too large" pointer with the real size is safer than a
      // truncated prefix that looks like the whole file.
      expect(result).toContain('70000 bytes')
      expect(result).toContain('read_file_range')
      expect(result).not.toContain('x'.repeat(100))
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

  describe('preview_html', () => {
    it('emits an inline preview with local CSS and JS inlined', async () => {
      await writeFile(
        join(workspace, 'game.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="game.css"></head><body><button id="win">Win</button><script src="game.js"></script></body></html>'
      )
      await writeFile(join(workspace, 'game.css'), '#win { animation: pulse 1s infinite; }')
      await writeFile(join(workspace, 'game.js'), 'document.body.dataset.ready = "true";')
      const capture = captureCalls()
      const ctx = { ...createMockContext(workspace), emit: capture.emit }
      const tool = previewHtmlTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; title?: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'game.html', title: 'Win animation' })

      expect(result).toContain('Rendered an inline chat preview')
      const success = capture.calls.find((call) => call.status === 'success')
      expect(success?.preview).toMatchObject({
        kind: 'html',
        title: 'Win animation',
        path: 'game.html'
      })
      expect(success?.preview?.content).toContain('<style')
      expect(success?.preview?.content).toContain('animation: pulse')
      expect(success?.preview?.content).toContain('<script')
      expect(success?.preview?.content).toContain('dataset.ready')
    })

    it('rejects non-HTML files', async () => {
      await writeFile(join(workspace, 'game.css'), 'body { color: red; }')
      const ctx = createMockContext(workspace)
      const tool = previewHtmlTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'game.css' })

      expect(result).toContain('preview_html requires an HTML file')
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

  describe('find_files', () => {
    it('finds paths by substring without reading file contents', async () => {
      await mkdir(join(workspace, 'src'))
      await writeFile(join(workspace, 'src', 'SettingsView.tsx'), 'needle in content')
      await writeFile(join(workspace, 'src', 'Other.tsx'), 'SettingsView only in content')
      const ctx = createMockContext(workspace)
      const tool = findFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { query: string }) => Promise<string>
      }

      const result = await tool.handler({ query: 'Settings' })

      expect(result).toContain('src/SettingsView.tsx')
      expect(result).not.toContain('Other.tsx')
    })

    it('supports simple wildcard path matching', async () => {
      await mkdir(join(workspace, 'src'))
      await writeFile(join(workspace, 'src', 'a.test.ts'), 'test')
      await writeFile(join(workspace, 'src', 'a.ts'), 'source')
      const ctx = createMockContext(workspace)
      const tool = findFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { query: string }) => Promise<string>
      }

      const result = await tool.handler({ query: 'src/*.test.ts' })

      expect(result).toContain('src/a.test.ts')
      expect(result).not.toContain('src/a.ts')
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

      expect(result).toBe('[lines.txt: lines 2-4 of 5. Next startLine: 5.]\nb\nc\nd')
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
      const returnedLines = result.split('\n').slice(1)

      expect(returnedLines).toHaveLength(200)
      expect(returnedLines[0]).toBe('line 300')
      expect(returnedLines[199]).toBe('line 499')
      expect(result).toContain('Next startLine: 500')
    })

    it('canonicalizes non-finite and oversized ends to the same effective range', async () => {
      const content = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')
      await writeFile(join(workspace, 'big.txt'), content)
      const ctx = createMockContext(workspace)
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
      }

      const infinite = await tool.handler({ path: './big.txt', startLine: 1, endLine: Infinity })
      const oversized = await tool.handler({
        path: 'big.txt',
        startLine: 1,
        endLine: 1_000_000_000_000_000
      })
      const omitted = await tool.handler({ path: 'big.txt', startLine: 1 })
      const blocked = await tool.handler({ path: 'big.txt', startLine: 1, endLine: 200 })

      // All four calls canonicalize to the identical effective range — the
      // first genuinely reads it; the second and third are already fully
      // covered (see `ReadCoverageTracker`) and are short-circuited instead
      // of re-serving the same content; the fourth is finally blocked
      // outright by the loop guard (a repeated identical fingerprint, same
      // as before this tracker existed).
      expect(infinite).toContain('[big.txt: lines 1-200 of 300. Next startLine: 201.]')
      expect(oversized).toContain('already read earlier this task')
      expect(omitted).toContain('already read earlier this task')
      expect(blocked).toContain('identical effective arguments 4 times this turn')
    })

    describe('cross-call read coverage (P0-C follow-up)', () => {
      it('serves only the new trailing portion of a range that partly overlaps an earlier read', async () => {
        // Regression fixture: a live retest reread the opening ~250 lines of
        // the same file across FIVE overlapping calls spread over several
        // continuation cycles instead of moving on to new files (see
        // `ReadCoverageTracker`'s doc comment). A single shared `ctx` here
        // stands in for one bounded task's shared tracker across cycles.
        const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n')
        await writeFile(join(workspace, 'big.txt'), content)
        const ctx = createMockContext(workspace)
        const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
        }

        const first = await tool.handler({ path: 'big.txt', startLine: 1, endLine: 200 })
        // Well under MAX_RANGE_LINES (200), so normalization doesn't reshape
        // this request itself — the only trimming should come from coverage.
        const second = await tool.handler({ path: 'big.txt', startLine: 150, endLine: 250 })

        expect(first).toContain('lines 1-200')
        // Only the genuinely new 201-250 portion is served, not a re-fetch of
        // the already-covered 150-200 prefix.
        expect(second).toContain('[big.txt: lines 201-250 of 500.')
        expect(second).toContain('line 201')
        expect(second).not.toContain('line 150\n')
        expect(second).toContain(
          'Lines 150-250 were requested; the rest was already read earlier this task'
        )
      })

      it('short-circuits an exact duplicate range without touching disk content again', async () => {
        const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
        await writeFile(join(workspace, 'small.txt'), content)
        const ctx = createMockContext(workspace)
        const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
        }

        await tool.handler({ path: 'small.txt', startLine: 1, endLine: 10 })
        const repeat = await tool.handler({ path: 'small.txt', startLine: 1, endLine: 10 })

        expect(repeat).toContain('already read earlier this task')
        expect(repeat).not.toContain('line 1\n')
      })

      it('short-circuits read_file_range for a file already read in full via read_file', async () => {
        await writeFile(join(workspace, 'whole.txt'), 'a\nb\nc')
        const ctx = createMockContext(workspace)
        const fileTool = readFileTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string }) => Promise<string>
        }
        const rangeTool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string; startLine: number }) => Promise<string>
        }

        await fileTool.handler({ path: 'whole.txt' })
        const rangeResult = await rangeTool.handler({ path: 'whole.txt', startLine: 1 })

        expect(rangeResult).toContain('already read earlier this task')
      })

      it('short-circuits a repeat read_file for a file already read in full', async () => {
        await writeFile(join(workspace, 'whole.txt'), 'a\nb\nc')
        const ctx = createMockContext(workspace)
        const tool = readFileTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string }) => Promise<string>
        }

        await tool.handler({ path: 'whole.txt' })
        const repeat = await tool.handler({ path: 'whole.txt' })

        expect(repeat).toContain('already read in full earlier this task')
      })

      it('skips a file in read_multiple_files that was already read in full', async () => {
        await writeFile(join(workspace, 'a.txt'), 'a')
        await writeFile(join(workspace, 'b.txt'), 'b')
        const ctx = createMockContext(workspace)
        const fileTool = readFileTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string }) => Promise<string>
        }
        const batchTool = readMultipleFilesTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { paths: string[] }) => Promise<string>
        }

        await fileTool.handler({ path: 'a.txt' })
        const batch = await batchTool.handler({ paths: ['a.txt', 'b.txt'] })

        expect(batch).toContain('a.txt ---\nAlready read in full earlier this task')
        expect(batch).toContain('--- b.txt ---\nb')
      })

      it('does not let one context leak coverage into a different context', async () => {
        const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
        await writeFile(join(workspace, 'small.txt'), content)
        const ctxA = createMockContext(workspace)
        const ctxB = createMockContext(workspace)
        const toolA = readFileRangeTool(createMockDefine(), ctxA) as unknown as {
          handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
        }
        const toolB = readFileRangeTool(createMockDefine(), ctxB) as unknown as {
          handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
        }

        await toolA.handler({ path: 'small.txt', startLine: 1, endLine: 10 })
        const resultB = await toolB.handler({ path: 'small.txt', startLine: 1, endLine: 10 })

        expect(resultB).not.toContain('already read earlier this task')
        expect(resultB).toContain('line 1')
      })
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

  describe('read_file_range with an active runtime budget', () => {
    // Deliberately small: 100 tokens ≈ 300 chars at the module's conservative
    // ratio, minus the range header reserve — enough for only a couple of
    // the ~47-char lines below, so the boundary logic is actually exercised.
    const TIGHT_BUDGET = {
      current: {
        contextSizeTokens: 8_192,
        inputLimitTokens: 7_373,
        fixedTokens: 4_037,
        minimumReplyReserveTokens: 1_024,
        maxTokensPerResult: 100
      }
    }

    it('bounds to complete lines and reports a truthful next start line', async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1} ${'a'.repeat(40)}`)
      await writeFile(join(workspace, 'big.txt'), lines.join('\n'))
      const ctx = { ...createMockContext(workspace), modelResultBudget: TIGHT_BUDGET }
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
      }

      const result = await tool.handler({ path: 'big.txt', startLine: 1, endLine: 50 })
      const [, ...returnedBody] = result.split('\n')

      // Every returned line must be a genuine, complete line from the file —
      // never a mid-line character cut — and the budget must have actually
      // bitten (fewer than the 50 requested lines came back).
      expect(returnedBody.length).toBeGreaterThan(0)
      expect(returnedBody.length).toBeLessThan(50)
      for (const line of returnedBody) expect(lines).toContain(line)

      const nextStartLine = Number(/Next startLine: (\d+)/.exec(result)?.[1])
      expect(nextStartLine).toBeGreaterThan(0)
      // The reported next line must be exactly the first line NOT included —
      // not the requested endLine, and not off by one in either direction.
      expect(lines[nextStartLine - 2]).toBe(returnedBody.at(-1))
      expect(returnedBody).not.toContain(lines[nextStartLine - 1])
    })

    it('labels a single line too long to fit whole as an honest partial, never a silent whole line', async () => {
      const oneHugeLine = 'a'.repeat(5_000)
      await writeFile(join(workspace, 'huge-line.txt'), oneHugeLine)
      const ctx = { ...createMockContext(workspace), modelResultBudget: TIGHT_BUDGET }
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number }) => Promise<string>
      }

      const result = await tool.handler({ path: 'huge-line.txt', startLine: 1 })

      expect(result).toContain('cut short')
      expect(result).not.toContain(oneHugeLine)
    })

    it('still returns the whole range unchanged when it already fits the budget', async () => {
      await writeFile(join(workspace, 'small.txt'), 'a\nb\nc')
      const generousBudget = {
        current: { ...TIGHT_BUDGET.current, maxTokensPerResult: 10_000 }
      }
      const ctx = { ...createMockContext(workspace), modelResultBudget: generousBudget }
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number; endLine: number }) => Promise<string>
      }

      const result = await tool.handler({ path: 'small.txt', startLine: 1, endLine: 3 })

      expect(result).toBe('[small.txt: lines 1-3 of 3.]\na\nb\nc')
    })
  })

  describe('read_multiple_files with an active runtime budget', () => {
    it('allocates the budget across files and honestly marks truncated ones', async () => {
      const linesA = Array.from({ length: 30 }, (_, i) => `a-line ${i}`)
      const linesB = Array.from({ length: 30 }, (_, i) => `b-line ${i}`)
      await writeFile(join(workspace, 'a.txt'), linesA.join('\n'))
      await writeFile(join(workspace, 'b.txt'), linesB.join('\n'))
      const ctx = {
        ...createMockContext(workspace),
        modelResultBudget: {
          current: {
            contextSizeTokens: 8_192,
            inputLimitTokens: 7_373,
            fixedTokens: 4_037,
            minimumReplyReserveTokens: 1_024,
            maxTokensPerResult: 100 // → 300 chars total, 150 chars/file share
          }
        }
      }
      const tool = readMultipleFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { paths: string[] }) => Promise<string>
      }

      const result = await tool.handler({ paths: ['a.txt', 'b.txt'] })

      expect(result).toContain('showing')
      expect(result).toContain('read_file_range')
      expect(result.length).toBeLessThan(linesA.join('\n').length + linesB.join('\n').length)
    })
  })
})
