import { mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileTouchAction } from '@shared/projectMemory.types'
import { computeModelToolResultBudget, type ModelToolResultBudget } from '../modelResultBudget'
import { maxRangeLinesFor, normalizeReadFileRangeArgs } from '../fileTools'
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
  createMockDefine,
  splitEvidenceMarker
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

      // The trailing line is the durable handle `retainAsEvidence` attaches so
      // the result stays recoverable after a transport trims it — see
      // `TurnEvidenceStore`. The content itself must still arrive whole.
      const [body, marker] = splitEvidenceMarker(result)
      expect(body).toBe(content)
      expect(marker).toMatch(/^\[evidence E\d+ · read_file · /)
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
    it('does not present interactive HTML as screenshot comparison evidence', () => {
      const tool = previewHtmlTool(createMockDefine(), createMockContext(workspace)) as unknown as {
        description: string
      }

      expect(tool.description).toContain('not for a before/after screenshot comparison')
      expect(tool.description).toContain('use inspect_visual')
    })

    it('emits an inline preview with local CSS and JS inlined', async () => {
      await writeFile(
        join(workspace, 'game.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="game.css"></head><body><img src="sprite.png"><button id="win">Win</button><script src="game.js"></script></body></html>'
      )
      await writeFile(join(workspace, 'game.css'), '#win { animation: pulse 1s infinite; }')
      await writeFile(join(workspace, 'game.js'), 'document.body.dataset.ready = "true";')
      await writeFile(join(workspace, 'sprite.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
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
      const content = success?.preview?.kind === 'html' ? success.preview.content : ''
      expect(content).toContain('<style')
      expect(content).toContain('animation: pulse')
      expect(content).toContain('<script')
      expect(content).toContain('dataset.ready')
      expect(content).toContain('data:image/png;base64,')
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

    /**
     * `.anodex` holds Anodex's own per-message checkpoint snapshots — copies of
     * the user's files. Unskipped, it filled the whole 200-match search budget
     * with those copies and the walk never reached the real source, because it
     * sorts before most project folders. Measured live: every one of the first
     * 200 matches came from `.anodex/checkpoints`, and the model concluded
     * "search tools are misbehaving" and read whole files by hand instead.
     * It also worsens the longer a project is used, since a checkpoint is
     * written per message.
     */
    it('ignores Anodex own checkpoint copies of the workspace', async () => {
      await mkdir(join(workspace, '.anodex', 'checkpoints'), { recursive: true })
      await writeFile(
        join(workspace, '.anodex', 'checkpoints', 'snapshot.json'),
        '{"before":"needle everywhere","after":"needle everywhere"}'
      )
      await writeFile(join(workspace, 'real.py'), 'needle in the real source')
      const ctx = createMockContext(workspace)
      const tool = searchFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { query: string; path?: string }) => Promise<string>
      }

      const result = await tool.handler({ query: 'needle' })

      expect(result).toContain('real.py')
      expect(result).not.toContain('.anodex')
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

  describe('search_files', () => {
    it('rejects an empty query instead of matching every line in the workspace', async () => {
      // find_files already guarded this. Without the same check here an empty
      // needle matched every line of every text file, and the model got back
      // whichever 100 the walk happened to reach first.
      await writeFile(join(workspace, 'a.txt'), 'alpha\nbeta')
      const ctx = createMockContext(workspace)
      const tool = searchFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { query: string }) => Promise<string>
      }

      const result = await tool.handler({ query: '   ' })

      expect(result).toContain('query was empty')
      expect(result).not.toContain('alpha')
    })
  })

  describe('read_file_range', () => {
    /** A runtime budget whose per-result cap is exactly `tokens` (chars = 3x). */
    const budgetOf = (tokens: number) => ({
      contextSizeTokens: 8_000,
      inputLimitTokens: 8_000,
      fixedTokens: 0,
      minimumReplyReserveTokens: 1_024,
      maxTokensPerResult: tokens
    })

    it('does not mark a line it only returned part of as read', async () => {
      // A budget that cuts mid-line: coverage is what the model has actually
      // seen, so recording the cut line as covered puts the rest of it
      // permanently out of reach — every later request short-circuits as
      // "already read earlier this task" and the tail is never returned.
      await writeFile(join(workspace, 'wide.txt'), ['short', 'x'.repeat(400), 'tail'].join('\n'))
      const ctx = createMockContext(workspace)
      // 300 chars, less the 200-char header reserve: the 400-char line cannot
      // fit whole, so it is returned cut short.
      ctx.modelResultBudget.current = budgetOf(100)
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
      }

      const first = await tool.handler({ path: 'wide.txt', startLine: 2, endLine: 2 })
      expect(first).toContain('was cut short')

      // Line 2 was only partly shown, so it must still count as unread.
      expect(ctx.ledger.reads.uncovered(join(workspace, 'wide.txt'), 2, 2)).toHaveLength(1)
    })

    it('says so plainly when no budget is left rather than inverting the range', async () => {
      await writeFile(join(workspace, 'lines.txt'), 'a\nb\nc')
      const ctx = createMockContext(workspace)
      // 150 chars, entirely consumed by the 200-char header reserve — nothing
      // is left for content, but the budget itself is not zero, so this is the
      // tool's own decision rather than an upstream cap.
      ctx.modelResultBudget.current = budgetOf(50)
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
      }

      const result = await tool.handler({ path: 'lines.txt', startLine: 2, endLine: 3 })

      // Falling through produced "lines 2-1" with empty content, which reads
      // as a broken tool rather than an exhausted budget.
      expect(result).toContain('no room left in the active context')
      expect(result).not.toMatch(/lines 2-1/)
    })

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
      const returnedLines = splitEvidenceMarker(result)[0].split('\n').slice(1)

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

      // All four calls canonicalize to the identical effective range, and all
      // four are served it. Coverage no longer turns a repeat into a pointer at
      // a stored copy: that copy is by definition the older one, and handing it
      // back is what left a live run editing against line numbers that had
      // already moved (see `projectHistoryForModel`).
      const header = '[big.txt: lines 1-200 of 300. Next startLine: 201.]'
      for (const result of [infinite, oversized, omitted, blocked]) {
        expect(result).toContain(header)
        expect(result).toContain('line 1')
        expect(result).not.toContain('already read earlier this task')
      }
    })

    describe('cross-call read coverage (P0-C follow-up)', () => {
      it('serves a repeat read_file for a file already read in full', async () => {
        await writeFile(join(workspace, 'whole.txt'), 'a\nb\nc')
        const capture = captureCalls()
        const ctx = { ...createMockContext(workspace), emit: capture.emit }
        const tool = readFileTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string }) => Promise<string>
        }

        await tool.handler({ path: 'whole.txt' })
        const repeat = await tool.handler({ path: 'whole.txt' })

        expect(repeat).toContain('a')
        expect(repeat).toContain('c')
        expect(repeat).not.toContain('already read in full')
        // It counts as progress now, because it did the work and returned the
        // file as it currently stands rather than refusing.
        expect(capture.calls.at(-1)?.madeProgress).not.toBe(false)
      })

      it('serves a repeat whole-file read again rather than dead-ending it', async () => {
        // A context epoch drops the file's content out of the model's active
        // context while this tracker still records it as read. That used to be
        // answered with "already read earlier this task" — leaving the model no
        // way to see content it had genuinely lost — softened by an allowance to
        // re-read three files per epoch. The result never leaves the ledger now,
        // so the honest answer is to say where it is.
        // Sized like a real source file. A result too small to be worth storing
        // has no copy to point at and correctly falls back to the plain
        // "nothing new here" answer — see `MIN_STORED_RESULT_CHARS`.
        const content = Array.from({ length: 40 }, (_, i) => `const marker${i} = ${i}`).join('\n')
        await writeFile(join(workspace, 'whole.txt'), content)
        const ctx = createMockContext(workspace)
        const tool = readFileTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string }) => Promise<string>
        }

        await tool.handler({ path: 'whole.txt' })

        // Every repeat serves the file again. Pointing at a stored copy was the
        // same dead end as refusing outright, one step removed: the copy is by
        // definition the older one, which is how four edits in a live run came
        // to be rejected for line numbers that had moved.
        for (let attempt = 0; attempt < 4; attempt++) {
          const repeat = await tool.handler({ path: 'whole.txt' })
          expect(repeat).toContain('const marker7 = 7')
          expect(repeat).not.toContain('already read in full')
        }
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

      it('reports no progress when read_multiple_files returns no new file content', async () => {
        await writeFile(join(workspace, 'a.txt'), 'a')
        await writeFile(join(workspace, 'b.txt'), 'b')
        const capture = captureCalls()
        const ctx = { ...createMockContext(workspace), emit: capture.emit }
        const fileTool = readFileTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string }) => Promise<string>
        }
        const batchTool = readMultipleFilesTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { paths: string[] }) => Promise<string>
        }

        await fileTool.handler({ path: 'a.txt' })
        await fileTool.handler({ path: 'b.txt' })
        await batchTool.handler({ paths: ['a.txt', 'b.txt'] })

        expect(capture.calls.at(-1)?.madeProgress).toBe(false)
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

    describe('code_outline suggestion for large files', () => {
      it('suggests code_outline on the first read of a large file', async () => {
        const content = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n')
        await writeFile(join(workspace, 'big.txt'), content)
        const ctx = createMockContext(workspace)
        const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string; startLine: number }) => Promise<string>
        }

        const result = await tool.handler({ path: 'big.txt', startLine: 1 })

        expect(result).toContain('This file has 600 lines; consider code_outline first')
      })

      it('does not repeat the suggestion on a later read of the same large file', async () => {
        const content = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n')
        await writeFile(join(workspace, 'big.txt'), content)
        const ctx = createMockContext(workspace)
        const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string; startLine: number }) => Promise<string>
        }

        await tool.handler({ path: 'big.txt', startLine: 1 })
        const second = await tool.handler({ path: 'big.txt', startLine: 201 })

        expect(second).not.toContain('consider code_outline')
      })

      it('does not suggest code_outline for a small file', async () => {
        const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
        await writeFile(join(workspace, 'small-file.txt'), content)
        const ctx = createMockContext(workspace)
        const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string; startLine: number }) => Promise<string>
        }

        const result = await tool.handler({ path: 'small-file.txt', startLine: 1 })

        expect(result).not.toContain('consider code_outline')
      })
    })

    describe('same-file read cap (deterministic diversity backstop)', () => {
      it('redirects once a single file has been read more times than the cap allows', async () => {
        // Regression: a live retest read one 2,352-line file across 15+
        // consecutive calls, methodically paging start to end, and never
        // touched any of the other 11+ files a 12-file audit needed — the
        // softer code_outline suggestion alone wasn't reliably followed.
        const content = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join('\n')
        await writeFile(join(workspace, 'huge.txt'), content)
        const ctx = createMockContext(workspace)
        const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
        }

        // Each call requests a genuinely new, non-overlapping 100-line
        // range, so none of these are short-circuited by coverage alone.
        let lastResult = ''
        for (let i = 0; i < 8; i++) {
          lastResult = await tool.handler({
            path: 'huge.txt',
            startLine: i * 100 + 1,
            endLine: i * 100 + 100
          })
        }

        expect(lastResult).toContain('this is read attempt 8 on this same file this task')
        expect(lastResult).toContain('move to a different file now')
        expect(lastResult).not.toContain('line 701')
      })

      it('does not redirect a different file even after another one hit the cap', async () => {
        const bigContent = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join('\n')
        await writeFile(join(workspace, 'huge.txt'), bigContent)
        await writeFile(join(workspace, 'other.txt'), 'a\nb\nc')
        const ctx = createMockContext(workspace)
        const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
        }

        for (let i = 0; i < 8; i++) {
          await tool.handler({ path: 'huge.txt', startLine: i * 100 + 1, endLine: i * 100 + 100 })
        }
        const otherResult = await tool.handler({ path: 'other.txt', startLine: 1 })

        expect(otherResult).toContain('a\nb\nc')
        expect(otherResult).not.toContain('read attempt')
      })

      it('allows exactly the cap worth of reads before redirecting', async () => {
        const content = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join('\n')
        await writeFile(join(workspace, 'huge.txt'), content)
        const ctx = createMockContext(workspace)
        const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
          handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
        }

        for (let i = 0; i < 6; i++) {
          const result = await tool.handler({
            path: 'huge.txt',
            startLine: i * 100 + 1,
            endLine: i * 100 + 100
          })
          expect(result).not.toContain('read attempt')
        }
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
      expect(result).toContain('Output stopped at the active context budget')
      expect(result).not.toContain('rest was already read earlier')
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

  describe('bounded disk reads and coverage-aware continuation', () => {
    it('rejects a read_file on byte size alone when it cannot possibly fit the budget', async () => {
      // 100-token budget → 300-char budget → 900-byte reject threshold at
      // the 3-bytes-per-char UTF-8 bound. 1,000 bytes is over it, so the
      // pointer must come back from `stat` alone (no line count — the file
      // is never decoded).
      await writeFile(join(workspace, 'big-enough.txt'), 'x'.repeat(1_000))
      const ctx = {
        ...createMockContext(workspace),
        modelResultBudget: {
          current: {
            contextSizeTokens: 8_192,
            inputLimitTokens: 7_373,
            fixedTokens: 4_037,
            minimumReplyReserveTokens: 1_024,
            maxTokensPerResult: 100
          }
        }
      }
      const tool = readFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const result = await tool.handler({ path: 'big-enough.txt' })

      expect(result).toContain('1000 bytes. Too large')
      expect(result).toContain('read_file_range')
      expect(result).not.toContain('x'.repeat(50))
    })

    it('redirects line-range reads and skips line-counting beyond the in-memory bound', async () => {
      // Just over the 10 MB line-tool bound — both tools must degrade
      // honestly instead of decoding it.
      await writeFile(join(workspace, 'huge.log'), 'x'.repeat(10 * 1024 * 1024 + 16))
      const ctx = createMockContext(workspace)
      const rangeTool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number }) => Promise<string>
      }
      const infoTool = getFileInfoTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      const range = await rangeTool.handler({ path: 'huge.log', startLine: 1 })
      const info = await infoTool.handler({ path: 'huge.log' })

      expect(range).toContain('beyond the')
      expect(range).toContain('run_command')
      expect(range).not.toContain('x'.repeat(50))
      expect(info).toContain('"lineCount": null')
      expect(info).toContain('"isFile": true')
    })

    it('serves fresh content when a fully-read file changed on disk out-of-band', async () => {
      // A run_command side effect or the user's own editor — no write tool
      // declares a touch, so only the mtime reconciliation can catch it.
      // Explicit utimes keep the mtimes deterministic (a same-millisecond
      // rewrite would otherwise be invisible and flaky).
      const target = join(workspace, 'shifting.txt')
      await writeFile(target, 'old content')
      await utimes(target, new Date(1_000_000), new Date(1_000_000))
      const ctx = createMockContext(workspace)
      const tool = readFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }

      expect(await tool.handler({ path: 'shifting.txt' })).toBe('old content')

      await writeFile(target, 'new content')
      await utimes(target, new Date(2_000_000), new Date(2_000_000))

      expect(await tool.handler({ path: 'shifting.txt' })).toBe('new content')
    })

    it('re-serves a covered range when the file changed on disk out-of-band', async () => {
      const target = join(workspace, 'shifting-range.txt')
      await writeFile(target, 'a\nb\nc')
      await utimes(target, new Date(1_000_000), new Date(1_000_000))
      const ctx = createMockContext(workspace)
      const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
      }

      const first = await tool.handler({ path: 'shifting-range.txt', startLine: 1, endLine: 3 })
      expect(first).toContain('a\nb\nc')

      await writeFile(target, 'x\ny\nz')
      await utimes(target, new Date(2_000_000), new Date(2_000_000))
      const second = await tool.handler({ path: 'shifting-range.txt', startLine: 1, endLine: 3 })

      expect(second).toContain('x\ny\nz')
      expect(second).not.toContain('already read earlier this task')
    })

    it('re-serves a changed file in read_multiple_files instead of skipping it', async () => {
      const target = join(workspace, 'shifting-batch.txt')
      await writeFile(target, 'old batch content')
      await utimes(target, new Date(1_000_000), new Date(1_000_000))
      const ctx = createMockContext(workspace)
      const fileTool = readFileTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { path: string }) => Promise<string>
      }
      const batchTool = readMultipleFilesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { paths: string[] }) => Promise<string>
      }

      await fileTool.handler({ path: 'shifting-batch.txt' })
      await writeFile(target, 'new batch content')
      await utimes(target, new Date(2_000_000), new Date(2_000_000))
      const batch = await batchTool.handler({ paths: ['shifting-batch.txt'] })

      expect(batch).toContain('new batch content')
      expect(batch).not.toContain('Already read in full earlier this task')
    })
  })
})

/**
 * The refusal used to be uniformly worded, return `success`, and cost nothing
 * to ignore — in chat `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef` the model
 * re-requested already-served ranges eleven consecutive times.
 *
 * Every request below uses a DIFFERENT already-covered range, which is the
 * incident's real shape (500-699, 470-669, 1-200, 200-399 …). Varying the
 * arguments defeats the exact-fingerprint loop guard entirely, so this ladder
 * is the only thing standing between the model and an unbounded read loop.
 */
describe('read_file_range coverage refusal escalation', () => {
  let workspace: string

  /** Distinct sub-ranges of a file already read in full — all zero-yield. */
  const COVERED_RANGES = [
    { startLine: 1, endLine: 20 },
    { startLine: 5, endLine: 25 },
    { startLine: 10, endLine: 30 },
    { startLine: 15, endLine: 35 },
    { startLine: 20, endLine: 40 },
    { startLine: 25, endLine: 45 },
    { startLine: 30, endLine: 50 }
  ]

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-refusal-'))
    await writeFile(
      join(workspace, 'big.js'),
      Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    )
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  function rangeTool(ctx: ReturnType<typeof createMockContext>): {
    handler: (args: { path: string; startLine: number; endLine?: number }) => Promise<string>
  } {
    return readFileRangeTool(createMockDefine(), ctx)
  }

  /**
   * Mark the file fully read without leaving an evidence descriptor behind.
   *
   * Coverage and the evidence record are separate: coverage can exist without a
   * descriptor (recorded by an older build, or a result too small to note). The
   * escalation ladder below is what answers that case.
   */
  function coverWithoutStoringEvidence(
    ctx: ReturnType<typeof createMockContext>,
    root: string
  ): void {
    ctx.ledger.reads.recordRange(join(root, 'big.js'), 1, 60)
  }

  it('does not abort before the threshold', async () => {
    const abortGeneration = vi.fn()
    const ctx = { ...createMockContext(workspace), abortGeneration }
    const tool = rangeTool(ctx)
    coverWithoutStoringEvidence(ctx, workspace)

    for (const range of COVERED_RANGES.slice(0, 4)) {
      await tool.handler({ path: 'big.js', ...range })
    }

    expect(abortGeneration).not.toHaveBeenCalled()
  })

  it('resets the escalation after a real mutation reopens the file', async () => {
    const ctx = createMockContext(workspace)
    const tool = rangeTool(ctx)
    await tool.handler({ path: 'big.js', startLine: 1, endLine: 60 })
    for (const range of COVERED_RANGES.slice(0, 3)) {
      await tool.handler({ path: 'big.js', ...range })
    }

    ctx.ledger.reads.noteMutation(join(workspace, 'big.js'))
    const afterMutation = await tool.handler({ path: 'big.js', startLine: 1, endLine: 20 })

    expect(afterMutation).not.toContain('Error:')
    expect(afterMutation).toContain('line 1')
  })
})

/**
 * The cap used to be a flat 200 lines regardless of hardware, while the result
 * budget scaled with the window. On a large context that made the line cap —
 * not memory — the binding constraint, so a model paged a file 200 lines at a
 * time when its budget could carry a thousand. Round trips are the expensive
 * part.
 */
describe('read range scales with the context budget', () => {
  const budget = (contextSizeTokens: number, fixedTokens: number): ModelToolResultBudget =>
    computeModelToolResultBudget({
      contextSizeTokens,
      inputLimitTokens: contextSizeTokens,
      fixedTokens
    })

  it('keeps the old behaviour when no budget has been measured', () => {
    expect(maxRangeLinesFor(null)).toBe(200)
  })

  it('never returns fewer lines than the old fixed cap', () => {
    for (const ctx of [2_048, 4_096, 8_192, 16_384, 32_768, 65_536]) {
      expect(maxRangeLinesFor(budget(ctx, Math.floor(ctx / 3)))).toBeGreaterThanOrEqual(200)
    }
  })

  it('grows with the window, so a big context makes fewer round trips', () => {
    const small = maxRangeLinesFor(budget(8_192, 3_000))
    const large = maxRangeLinesFor(budget(65_536, 10_000))
    expect(large).toBeGreaterThan(small * 4)
  })

  it('shrinks again as a turn fills up', () => {
    const early = maxRangeLinesFor(budget(65_536, 10_000))
    const late = maxRangeLinesFor(budget(65_536, 55_000))
    expect(late).toBeLessThan(early)
    expect(late).toBeGreaterThanOrEqual(200)
  })

  it('caps one request however much room there is', () => {
    expect(maxRangeLinesFor(budget(1_048_576, 1_000))).toBeLessThanOrEqual(2_000)
  })

  it('applies the limit to the requested range', () => {
    const wide = normalizeReadFileRangeArgs({ path: 'a.ts', startLine: 1, endLine: 9_999 }, 900)
    expect(wide.endLine).toBe(900)
    const narrow = normalizeReadFileRangeArgs({ path: 'a.ts', startLine: 1, endLine: 9_999 }, 200)
    expect(narrow.endLine).toBe(200)
  })
})
