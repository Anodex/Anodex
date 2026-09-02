import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTaskLedger, GATHERING_HARD_LIMIT } from '../taskLedger'
import type { ToolCall, ToolConfirmRequest } from '@shared/tools.types'
import {
  appendFileTool,
  deleteFileTool,
  editFileTool,
  FILE_WRITE_CHUNK_TARGET_CHARS,
  MAX_FILE_WRITE_CONTENT_CHARS,
  moveFileTool,
  patchFileTool,
  replaceLinesTool,
  writeFileTool
} from '../mutationTools'
import { checkpointStore } from '../../checkpoints/CheckpointStore'
import {
  captureCalls,
  captureConfirmations,
  createMockContext,
  createMockDefine
} from './test-helpers'

describe('edit_file', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-edit-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('replaces a unique block of text', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello world')
    const ctx = createMockContext(workspace)
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'a.txt', oldText: 'world', newText: 'there' })

    expect(result).toContain('Edited')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('hello there')
  })

  /**
   * The re-read an edit used to force is the single largest source of wasted
   * calls in a long turn -- see `editEcho.ts`. Proven end to end here rather
   * than only on the helper, because the seam that failed was the tool
   * answering "Edited a.txt." and nothing else.
   */
  it('answers with the edited region and its new line numbers, so no re-read is needed', async () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    await writeFile(join(workspace, 'a.txt'), before)
    const ctx = createMockContext(workspace)
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    const result = await tool.handler({
      path: 'a.txt',
      oldText: 'line 10',
      newText: 'CHANGED'
    })

    expect(result).toContain('Edited a.txt (1 replacement).')
    expect(result).toContain('of 20 after the edit')
    expect(result).toContain('CHANGED')
    expect(result).toContain('line 9')
    expect(result).toContain('line 11')
  })

  it('states how far line numbers moved when an edit changes the line count', async () => {
    await writeFile(join(workspace, 'a.txt'), ['a', 'b', 'c'].join('\n'))
    const ctx = createMockContext(workspace)
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    const result = await tool.handler({
      path: 'a.txt',
      oldText: 'b',
      newText: ['b1', 'b2'].join('\n')
    })

    expect(result).toContain('gained 1 line')
    expect(result).toContain('have shifted')
  })

  it('rejects an empty oldText with a clear, actionable error instead of the uniqueness check', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello world')
    const ctx = createMockContext(workspace)
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'a.txt', oldText: '', newText: 'there' })

    expect(result).toContain('oldText was empty')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('hello world')
  })

  it('rejects text that is not found in the file', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello world')
    const ctx = createMockContext(workspace)
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'a.txt', oldText: 'missing', newText: 'there' })

    expect(result).toContain('not found')
  })

  it('rejects text that appears more than once', async () => {
    await writeFile(join(workspace, 'a.txt'), 'foo foo')
    const ctx = createMockContext(workspace)
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'a.txt', oldText: 'foo', newText: 'bar' })

    expect(result).toContain('appears 2 times')
  })

  it('captures a before/after diff of the whole file for the UI', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello world')
    const ctx = createMockContext(workspace)
    const capture = captureCalls<ToolCall>()
    ctx.emit = capture.emit
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    await tool.handler({ path: 'a.txt', oldText: 'world', newText: 'there' })

    const success = capture.calls.find((c) => c.status === 'success')
    expect(success?.diff).toEqual({ path: 'a.txt', before: 'hello world', after: 'hello there' })
  })

  it('shows the same before/after diff in the confirm prompt itself, before approval', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello world')
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(workspace), confirm }
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    await tool.handler({ path: 'a.txt', oldText: 'world', newText: 'there' })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.diff).toEqual({
      path: 'a.txt',
      before: 'hello world',
      after: 'hello there'
    })
  })

  it('never shows a confirm prompt for a call already known to fail', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello world')
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(workspace), confirm }
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    await tool.handler({ path: 'a.txt', oldText: '', newText: 'there' })
    await tool.handler({ path: 'a.txt', oldText: 'missing', newText: 'there' })

    expect(requests).toHaveLength(0)
  })

  it('rejects the write if the file changed after the confirm prompt was shown', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello world')
    const ctx = {
      ...createMockContext(workspace),
      confirm: async (_request: ToolConfirmRequest) => {
        // Simulate a concurrent edit landing while the user is looking at the prompt.
        await writeFile(join(workspace, 'a.txt'), 'hello world, edited elsewhere')
        return { approved: true }
      }
    }
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'a.txt', oldText: 'world', newText: 'there' })

    expect(result).toContain('changed since this edit was proposed')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('hello world, edited elsewhere')
  })
})

describe('binary mutation checkpoints', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-binary-checkpoint-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('checkpoints and restores a deleted binary file', async () => {
    const original = Buffer.from([0, 1, 2, 255, 128, 64])
    await writeFile(join(workspace, 'asset.bin'), original)
    const ctx = { ...createMockContext(workspace), projectId: 'project-1' }
    const tool = deleteFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    await tool.handler({ path: 'asset.bin' })

    const preview = checkpointStore.inspect(workspace, 'test-conversation', 'test-message')
    expect(preview.files[0]).toMatchObject({
      path: 'asset.bin',
      kind: 'deleted',
      binary: true,
      beforeSize: original.length
    })
    checkpointStore.restore(workspace, 'test-conversation', 'test-message')
    expect(await readFile(join(workspace, 'asset.bin'))).toEqual(original)
  })

  it('checkpoints and restores both sides of a binary move', async () => {
    const original = Buffer.from([0, 10, 20, 30, 255])
    await writeFile(join(workspace, 'source.bin'), original)
    const ctx = { ...createMockContext(workspace), projectId: 'project-1' }
    const tool = moveFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { sourcePath: string; targetPath: string }) => Promise<string>
    }

    await tool.handler({ sourcePath: 'source.bin', targetPath: 'nested/target.bin' })

    const preview = checkpointStore.inspect(workspace, 'test-conversation', 'test-message')
    expect(preview.files).toMatchObject([
      { path: 'source.bin', kind: 'deleted', binary: true },
      { path: 'nested/target.bin', kind: 'created', binary: true }
    ])
    checkpointStore.restore(workspace, 'test-conversation', 'test-message')
    expect(await readFile(join(workspace, 'source.bin'))).toEqual(original)
    await expect(readFile(join(workspace, 'nested', 'target.bin'))).rejects.toThrow()
  })

  it('preserves binary bytes when write_file overwrites an existing asset', async () => {
    const original = Buffer.from([0, 200, 100, 50, 25])
    await writeFile(join(workspace, 'asset.bin'), original)
    const ctx = { ...createMockContext(workspace), projectId: 'project-1' }
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    await tool.handler({ path: 'asset.bin', content: 'text replacement' })

    const preview = checkpointStore.inspect(workspace, 'test-conversation', 'test-message')
    expect(preview.files[0]).toMatchObject({
      path: 'asset.bin',
      kind: 'modified',
      binary: true,
      beforeSize: original.length,
      afterSize: Buffer.byteLength('text replacement')
    })
    checkpointStore.restore(workspace, 'test-conversation', 'test-message')
    expect(await readFile(join(workspace, 'asset.bin'))).toEqual(original)
  })
})

describe('write_file diff capture', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-write-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('captures an empty "before" when creating a new file', async () => {
    const ctx = createMockContext(workspace)
    const capture = captureCalls<ToolCall>()
    ctx.emit = capture.emit
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    await tool.handler({ path: 'new.txt', content: 'hello' })

    const success = capture.calls.find((c) => c.status === 'success')
    expect(success?.diff).toEqual({ path: 'new.txt', before: '', after: 'hello' })
  })

  it('captures the prior content when overwriting an existing file', async () => {
    await writeFile(join(workspace, 'existing.txt'), 'old content')
    const ctx = createMockContext(workspace)
    const capture = captureCalls<ToolCall>()
    ctx.emit = capture.emit
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    await tool.handler({ path: 'existing.txt', content: 'new content' })

    const success = capture.calls.find((c) => c.status === 'success')
    expect(success?.diff).toEqual({
      path: 'existing.txt',
      before: 'old content',
      after: 'new content'
    })
  })

  it('omits the diff when the written content is unchanged', async () => {
    await writeFile(join(workspace, 'same.txt'), 'same content')
    const ctx = createMockContext(workspace)
    const capture = captureCalls<ToolCall>()
    ctx.emit = capture.emit
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    await tool.handler({ path: 'same.txt', content: 'same content' })

    const success = capture.calls.find((c) => c.status === 'success')
    expect(success?.diff).toBeUndefined()
  })

  it('shows the same before/after diff in the confirm prompt itself, before approval', async () => {
    await writeFile(join(workspace, 'existing.txt'), 'old content')
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(workspace), confirm }
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    await tool.handler({ path: 'existing.txt', content: 'new content' })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.diff).toEqual({
      path: 'existing.txt',
      before: 'old content',
      after: 'new content'
    })
  })

  it('does not overwrite a file changed while approval is pending', async () => {
    await writeFile(join(workspace, 'existing.txt'), 'old content')
    const ctx = {
      ...createMockContext(workspace),
      confirm: async () => {
        await writeFile(join(workspace, 'existing.txt'), 'newer user content')
        return { approved: true }
      }
    }
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'existing.txt', content: 'assistant content' })

    expect(result).toContain('changed since this write was proposed')
    expect(await readFile(join(workspace, 'existing.txt'), 'utf-8')).toBe('newer user content')
  })

  it('omits the diff for files larger than the size cap', async () => {
    await writeFile(join(workspace, 'huge.txt'), 'x'.repeat(60_000))
    const ctx = createMockContext(workspace)
    const capture = captureCalls<ToolCall>()
    ctx.emit = capture.emit
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    await tool.handler({ path: 'huge.txt', content: 'replacement' })

    const success = capture.calls.find((c) => c.status === 'success')
    expect(success?.diff).toBeUndefined()
  })

  // The chunk target is advice given before generation, not a refusal after
  // it. A payload that arrived whole is complete and safe to apply, and
  // discarding it is what sent a real run into an eight-attempt retry loop.
  it('writes a payload over the chunk target rather than refusing it', async () => {
    const ctx = createMockContext(workspace)
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }
    const content = 'x'.repeat(FILE_WRITE_CHUNK_TARGET_CHARS + 1)

    const result = await tool.handler({ path: 'long.html', content })

    expect(result).toContain('Wrote')
    expect(await readFile(join(workspace, 'long.html'), 'utf-8')).toBe(content)
  })

  it('rejects a write past the hard limit before touching the workspace', async () => {
    const ctx = createMockContext(workspace)
    const capture = captureCalls<ToolCall>()
    ctx.emit = capture.emit
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    const result = await tool.handler({
      path: 'too-large.html',
      content: 'x'.repeat(MAX_FILE_WRITE_CONTENT_CHARS + 1)
    })

    expect(result).toContain('use append_file')
    expect(capture.calls.find((call) => call.status === 'error')?.result).toContain(
      String(MAX_FILE_WRITE_CONTENT_CHARS)
    )
    await expect(readFile(join(workspace, 'too-large.html'), 'utf-8')).rejects.toThrow()
  })
})

describe('append_file', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-append-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('appends a chunk to an existing UTF-8 file', async () => {
    await writeFile(join(workspace, 'a.txt'), 'first')
    const ctx = createMockContext(workspace)
    const tool = appendFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'a.txt', content: ' second' })

    expect(result).toContain('Appended')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('first second')
  })

  it('appends a chunk over the target rather than discarding it', async () => {
    await writeFile(join(workspace, 'a.txt'), 'first')
    const ctx = createMockContext(workspace)
    const tool = appendFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }
    const content = 'x'.repeat(FILE_WRITE_CHUNK_TARGET_CHARS + 1)

    const result = await tool.handler({ path: 'a.txt', content })

    expect(result).toContain('Appended')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe(`first${content}`)
  })

  it('rejects an append past the hard limit, leaving the file untouched', async () => {
    await writeFile(join(workspace, 'a.txt'), 'first')
    const ctx = createMockContext(workspace)
    const tool = appendFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    const result = await tool.handler({
      path: 'a.txt',
      content: 'x'.repeat(MAX_FILE_WRITE_CONTENT_CHARS + 1)
    })

    expect(result).toContain('following append_file call')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('first')
  })

  it('does not append when the file changes while approval is pending', async () => {
    await writeFile(join(workspace, 'a.txt'), 'first')
    const ctx = {
      ...createMockContext(workspace),
      confirm: async () => {
        await writeFile(join(workspace, 'a.txt'), 'user change')
        return { approved: true }
      }
    }
    const tool = appendFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'a.txt', content: ' assistant' })

    expect(result).toContain('changed since this append was proposed')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('user change')
  })
})

describe('patch_file', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-patch-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('applies several replacements to one file', async () => {
    await writeFile(join(workspace, 'a.txt'), 'alpha beta gamma')
    const ctx = createMockContext(workspace)
    const tool = patchFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: {
        path: string
        replacements: Array<{ oldText: string; newText: string }>
      }) => Promise<string>
    }

    const result = await tool.handler({
      path: 'a.txt',
      replacements: [
        { oldText: 'alpha', newText: 'one' },
        { oldText: 'gamma', newText: 'three' }
      ]
    })

    expect(result).toContain('2 replacement')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('one beta three')
  })

  it('can target a specific occurrence when text repeats', async () => {
    await writeFile(join(workspace, 'a.txt'), 'item\nitem\nitem')
    const ctx = createMockContext(workspace)
    const tool = patchFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: {
        path: string
        replacements: Array<{ oldText: string; newText: string; occurrence?: number }>
      }) => Promise<string>
    }

    await tool.handler({
      path: 'a.txt',
      replacements: [{ oldText: 'item', newText: 'chosen', occurrence: 2 }]
    })

    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('item\nchosen\nitem')
  })

  it('requires occurrence or replaceAll when text repeats', async () => {
    await writeFile(join(workspace, 'a.txt'), 'item item')
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(workspace), confirm }
    const tool = patchFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: {
        path: string
        replacements: Array<{ oldText: string; newText: string }>
      }) => Promise<string>
    }

    const result = await tool.handler({
      path: 'a.txt',
      replacements: [{ oldText: 'item', newText: 'chosen' }]
    })

    expect(result).toContain('provide occurrence or replaceAll')
    expect(requests).toHaveLength(0)
  })

  it('tells the model when replacements were truncated instead of dropping them silently', async () => {
    // Delimited markers so no token is a substring of another (e.g. "word1"
    // inside "word10"), which would otherwise trip the occurrence-ambiguity
    // check unrelated to the truncation behavior under test.
    const words = Array.from({ length: 25 }, (_, i) => `<<${i}>>`)
    await writeFile(join(workspace, 'a.txt'), words.join(' '))
    const ctx = createMockContext(workspace)
    const tool = patchFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: {
        path: string
        replacements: Array<{ oldText: string; newText: string }>
      }) => Promise<string>
    }

    const replacements = words.map((w, i) => ({ oldText: w, newText: `[${i}]` }))
    const result = await tool.handler({ path: 'a.txt', replacements })

    expect(result).toContain('20 replacement')
    expect(result).toContain('Only the first 20 of 25 requested replacements were applied')
    expect(result).toContain('remaining 5 were dropped')
    const updated = await readFile(join(workspace, 'a.txt'), 'utf-8')
    expect(updated).toContain('[0]')
    expect(updated).toContain('<<24>>') // beyond the 20-replacement cap, left untouched
  })
})

describe('replacement edits on non-UTF-8 files', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-encoding-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  /** Latin-1 bytes: no NUL, few control bytes, so `isLikelyBinary` sees text. */
  const latin1 = () => Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6f, 0x6b])

  it('refuses an edit_file that would rewrite bytes it never touched', async () => {
    const file = join(workspace, 'legacy.txt')
    await writeFile(file, latin1())
    const ctx = createMockContext(workspace)
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'legacy.txt', oldText: 'ok', newText: 'done' })

    // Decoding replaces the invalid 0xE9 with U+FFFD, and writing the string
    // back would persist that — destroying a byte the edit never referred to.
    // The checkpoint stores the same lossy text, so a restore could not undo it.
    expect(result).toContain('not valid UTF-8')
    expect(await readFile(file)).toEqual(latin1())
  })

  it('refuses a patch_file for the same reason', async () => {
    const file = join(workspace, 'legacy.txt')
    await writeFile(file, latin1())
    const ctx = createMockContext(workspace)
    const tool = patchFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: {
        path: string
        replacements: Array<{ oldText: string; newText: string }>
      }) => Promise<string>
    }

    const result = await tool.handler({
      path: 'legacy.txt',
      replacements: [{ oldText: 'ok', newText: 'done' }]
    })

    expect(result).toContain('not valid UTF-8')
    expect(await readFile(file)).toEqual(latin1())
  })

  it('still edits an ordinary UTF-8 file containing non-ASCII text', async () => {
    // The guard must reject invalid encoding, not non-ASCII content — a file
    // full of accents or emoji is perfectly valid UTF-8 and must stay editable.
    const file = join(workspace, 'unicode.txt')
    await writeFile(file, 'café — ok', 'utf-8')
    const ctx = createMockContext(workspace)
    const tool = editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'unicode.txt', oldText: 'ok', newText: 'done' })

    expect(result).toContain('Edited')
    expect(await readFile(file, 'utf-8')).toBe('café — done')
  })
})

describe('move_file over an existing target', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-move-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('says that the target will be overwritten before it is approved', async () => {
    await writeFile(join(workspace, 'src.txt'), 'new')
    await writeFile(join(workspace, 'dest.txt'), 'the only copy')
    const confirmations = captureConfirmations()
    const ctx = { ...createMockContext(workspace), confirm: confirmations.confirm }
    const tool = moveFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { sourcePath: string; targetPath: string }) => Promise<string>
    }

    await tool.handler({ sourcePath: 'src.txt', targetPath: 'dest.txt' })

    // `rename` replaces the target outright, and the card said only
    // "Move A to B" — the destruction of B was the one thing it omitted.
    const detail = confirmations.requests.map((request) => request.detail).join('\n')
    expect(detail).toContain('OVERWRITES')
    expect(detail).toContain('dest.txt')
  })
})

describe('replace_lines', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-replace-lines-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  function lineTool(ctx: ReturnType<typeof createMockContext>): {
    handler: (args: {
      path: string
      startLine: number
      endLine: number
      newText: string
      expectedFirstLine?: string
    }) => Promise<string>
  } {
    return replaceLinesTool(createMockDefine(), ctx)
  }

  it('replaces a numbered range without needing the original text', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 3,
      newText: 'TWO\nTHREE',
      expectedFirstLine: 'two'
    })

    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('one\nTWO\nTHREE\nfour\n')
    // The new total is what lets the next call address the file without
    // re-reading it, so it has to be reported.
    expect(result).toContain('lines')
  })

  it('replaces several lines with fewer, and says the numbers below have shifted', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 3,
      newText: 'merged',
      expectedFirstLine: 'two'
    })

    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('one\nmerged\nfour\n')
    expect(result).toContain('shifted')
  })

  it('deletes the range when newText is empty', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\ntwo\nthree\n')
    const ctx = createMockContext(workspace)

    await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 2,
      newText: '',
      expectedFirstLine: 'two'
    })

    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('one\nthree\n')
  })

  it('refuses a stale anchor instead of overwriting the wrong code', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\ntwo\nthree\n')
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 2,
      newText: 'REPLACED',
      expectedFirstLine: 'const planetData = ['
    })

    expect(result).toContain('Error:')
    expect(result).toContain('stale')
    // Unchanged: a wrong line number must never silently damage the file.
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('one\ntwo\nthree\n')
  })

  /**
   * The old message ended at "read the file again", which costs a read and a
   * retry. One agent run lost five calls to it -- every one a line that had
   * moved a few rows after the model's own edit, text still present and
   * unambiguous. The file is right there, so say where it went.
   */
  it('applies the edit where the anchor text actually is', async () => {
    // This used to be refused with "that text is now on line 4 — retry there",
    // which described the correct edit and then declined to make it. The line
    // the model named is still not touched: `bbb` survives.
    await writeFile(join(workspace, 'a.txt'), ['aaa', 'bbb', 'ccc', 'target', 'eee'].join('\n'))
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 2,
      newText: 'REPLACED',
      expectedFirstLine: 'target'
    })

    expect(result).not.toContain('Error')
    expect(result).toContain('stale by 2 line(s)')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe(
      ['aaa', 'bbb', 'ccc', 'REPLACED', 'eee'].join('\n')
    )
  })

  /** Guessing which one was meant is the thing the interlock exists to stop. */
  it('falls back to re-reading when the text appears more than once', async () => {
    await writeFile(join(workspace, 'a.txt'), ['aaa', 'bbb', 'dup', 'ccc', 'dup'].join('\n'))
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 2,
      newText: 'REPLACED',
      expectedFirstLine: 'dup'
    })

    expect(result).toContain('Read the file again')
    expect(result).not.toContain('now on line')
  })

  it('still says to re-read when the text is genuinely gone', async () => {
    await writeFile(join(workspace, 'a.txt'), ['aaa', 'bbb', 'ccc'].join('\n'))
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 2,
      newText: 'REPLACED',
      expectedFirstLine: 'vanished'
    })

    expect(result).toContain('Read the file again')
  })

  it('accepts an anchor that differs only in surrounding whitespace', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\n    indented\nthree\n')
    const ctx = createMockContext(workspace)

    await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 2,
      newText: 'replaced',
      expectedFirstLine: 'indented'
    })

    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('one\nreplaced\nthree\n')
  })

  it('preserves CRLF line endings rather than silently converting them', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\r\ntwo\r\nthree\r\n')
    const ctx = createMockContext(workspace)

    await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 2,
      newText: 'TWO\nEXTRA',
      expectedFirstLine: 'two'
    })

    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe(
      'one\r\nTWO\r\nEXTRA\r\nthree\r\n'
    )
  })

  it('reports a start line past the end of the file instead of appending', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\ntwo\n')
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 40,
      endLine: 41,
      newText: 'x',
      expectedFirstLine: 'nothing here'
    })

    expect(result).toContain('Error:')
    expect(result).toContain('beyond the file')
  })

  it('clamps an end line past the file rather than failing a valid edit', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\ntwo\nthree\n')
    const ctx = createMockContext(workspace)

    await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 900,
      newText: 'tail',
      expectedFirstLine: 'two'
    })

    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('one\ntail')
  })

  it('rejects an inverted range', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\ntwo\n')
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 1,
      newText: 'x',
      expectedFirstLine: 'two'
    })

    expect(result).toContain('Error:')
    expect(await readFile(join(workspace, 'a.txt'), 'utf-8')).toBe('one\ntwo\n')
  })

  it('records a diff so the change is reviewable and restorable', async () => {
    await writeFile(join(workspace, 'a.txt'), 'one\ntwo\nthree\n')
    const { calls, emit } = captureCalls()
    const ctx = { ...createMockContext(workspace), emit }

    await lineTool(ctx).handler({
      path: 'a.txt',
      startLine: 2,
      endLine: 2,
      newText: 'TWO',
      expectedFirstLine: 'two'
    })

    const success = calls.find((call) => call.status === 'success')
    expect(success?.diff?.before).toBe('one\ntwo\nthree\n')
    expect(success?.diff?.after).toBe('one\nTWO\nthree\n')
  })
})

/**
 * The corruption a live run produced, reproduced exactly.
 *
 * Anodex was asked why a page rendered black. It made eighteen `replace_lines`
 * edits, two of which re-stated a line that already sat just outside the range
 * they replaced. The file ended with `const planets = [];` three times over —
 * a `SyntaxError`, so the module never parsed and the page stayed black. The
 * tool added to make editing possible had produced the very symptom it was
 * asked to fix.
 */
describe('replace_lines refuses to duplicate its own neighbours', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-seam-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  function lineTool(ctx: ReturnType<typeof createMockContext>): {
    handler: (args: {
      path: string
      startLine: number
      endLine: number
      newText: string
      expectedFirstLine?: string
    }) => Promise<string>
  } {
    return replaceLinesTool(createMockDefine(), ctx)
  }

  const SOURCE = [
    '    // Create planets',
    '    const planets = [];',
    '    const orbits = [];',
    '    let rotationSpeed = 1;'
  ].join('\n')

  it('refuses a replacement that repeats the line just after the range', async () => {
    await writeFile(join(workspace, 'a.js'), SOURCE)
    const ctx = createMockContext(workspace)

    // Replacing the comment, but re-stating the declaration that follows it.
    const result = await lineTool(ctx).handler({
      path: 'a.js',
      startLine: 1,
      endLine: 1,
      newText: '    // Create planets and orbits\n    const planets = [];',
      expectedFirstLine: '// Create planets'
    })

    expect(result).toContain('Error:')
    expect(result).toContain('already exists immediately after')
    expect(await readFile(join(workspace, 'a.js'), 'utf-8')).toBe(SOURCE)
  })

  it('refuses a replacement that repeats the line just before the range', async () => {
    await writeFile(join(workspace, 'a.js'), SOURCE)
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.js',
      startLine: 3,
      endLine: 3,
      newText: '    const planets = [];\n    const orbits = [];',
      expectedFirstLine: 'const orbits = [];'
    })

    expect(result).toContain('Error:')
    expect(result).toContain('already exists immediately before')
    expect(await readFile(join(workspace, 'a.js'), 'utf-8')).toBe(SOURCE)
  })

  it('allows ordinary repeated structure like a closing brace', async () => {
    const braces = ['function a() {', '  return 1;', '}', '}'].join('\n')
    await writeFile(join(workspace, 'b.js'), braces)
    const ctx = createMockContext(workspace)

    // `}` repeats constantly in real code; refusing it would make the tool
    // unusable, so only substantial lines count.
    const result = await lineTool(ctx).handler({
      path: 'b.js',
      startLine: 2,
      endLine: 2,
      newText: '  return 2;\n}',
      expectedFirstLine: 'return 1;'
    })

    expect(result).not.toContain('Error:')
  })

  it('requires the anchor rather than treating it as optional', async () => {
    await writeFile(join(workspace, 'a.js'), SOURCE)
    const ctx = createMockContext(workspace)

    // The live corruption came in exactly here: a `70-75` edit was correctly
    // refused as stale, and the model immediately retried the same region
    // without a usable anchor. An interlock a caller may decline is not one.
    const result = await lineTool(ctx).handler({
      path: 'a.js',
      startLine: 2,
      endLine: 2,
      newText: '    const planets = [];'
    })

    expect(result).toContain('Error:')
    expect(result).toContain('expectedFirstLine is required')
    expect(await readFile(join(workspace, 'a.js'), 'utf-8')).toBe(SOURCE)
  })
})

/**
 * The data loss, reproduced.
 *
 * A live run replaced a 41,455-byte working module with a 1,839-byte first
 * chunk, never appended the rest, ran out of provider rounds, and left an
 * unparseable stub where the user's page had been. Two independent defects
 * combined: `append_file` was not in the model's native tool surface (see
 * `DIRECT_TOOL_PRIORITY`), and nothing refused the truncating write.
 */
describe('write_file will not truncate a substantial file', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-overwrite-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  function writeTool(ctx: ReturnType<typeof createMockContext>): {
    handler: (args: { path: string; content: string }) => Promise<string>
  } {
    return writeFileTool(createMockDefine(), ctx)
  }

  it('refuses to replace a large file with a small first chunk', async () => {
    const original = 'const x = 1;\n'.repeat(600)
    await writeFile(join(workspace, 'big.js'), original)
    const ctx = createMockContext(workspace)

    const result = await writeTool(ctx).handler({
      path: 'big.js',
      content: '// Rewritten\nclass Thing {\n  constructor() {}\n}\n'
    })

    expect(result).toContain('Error:')
    expect(result).toContain('discarding most of the file')
    expect(result).toContain('replace_lines')
    // The file is untouched, which is the entire point.
    expect(await readFile(join(workspace, 'big.js'), 'utf-8')).toBe(original)
  })

  it('still creates a new file of any size', async () => {
    const ctx = createMockContext(workspace)

    const result = await writeTool(ctx).handler({ path: 'new.js', content: 'const a = 1;\n' })

    expect(result).not.toContain('Error:')
    expect(await readFile(join(workspace, 'new.js'), 'utf-8')).toBe('const a = 1;\n')
  })

  it('still rewrites a small file wholesale', async () => {
    await writeFile(join(workspace, 'small.js'), 'const a = 1;\n')
    const ctx = createMockContext(workspace)

    const result = await writeTool(ctx).handler({ path: 'small.js', content: 'const b = 2;\n' })

    expect(result).not.toContain('Error:')
    expect(await readFile(join(workspace, 'small.js'), 'utf-8')).toBe('const b = 2;\n')
  })

  it('allows a rewrite that keeps most of the content', async () => {
    // Both sides stay under `MAX_FILE_WRITE_CONTENT_CHARS`, so the only rule
    // under test here is the shrink ratio.
    const original = 'const x = 1;\n'.repeat(250)
    await writeFile(join(workspace, 'big.js'), original)
    const ctx = createMockContext(workspace)

    const result = await writeTool(ctx).handler({
      path: 'big.js',
      content: 'const y = 2;\n'.repeat(240)
    })

    expect(result).not.toContain('Error:')
  })
})

describe('edit_file near-miss reporting', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-nearmiss-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  function tool(ctx: ReturnType<typeof createMockContext>) {
    return editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }
  }

  const source = [
    'function draw(scene) {',
    '  const width = scene.width;',
    '    ctx.clearRect(0, 0, width, height);',
    '    ctx.fillStyle = accent;',
    '  return scene;',
    '}'
  ].join('\n')

  it('says what the file actually holds where the text nearly matched', async () => {
    // The measured failure: the model reconstructs oldText from memory and
    // loses the indentation. The file is already in hand, so the retry does
    // not need a separate read to become exact.
    await writeFile(join(workspace, 'draw.js'), source)
    const ctx = createMockContext(workspace)

    const result = await tool(ctx).handler({
      path: 'draw.js',
      oldText: ['ctx.clearRect(0, 0, width, height);', 'ctx.fillStyle = accent;'].join('\n'),
      newText: 'ctx.fillStyle = accent;'
    })

    expect(result).toContain('Error')
    expect(result).toContain('line 3')
    // The actual text, so the model can copy it rather than guess again.
    expect(result).toContain('    ctx.clearRect(0, 0, width, height);')
    expect(result).toContain('    ctx.fillStyle = accent;')
  })

  it('stays silent when the anchor line appears more than once', async () => {
    // Same rule the numbered-edit relocation keeps: several candidates cannot
    // be resolved without guessing which was meant, and guessing is what this
    // interlock exists to prevent.
    await writeFile(
      join(workspace, 'dup.js'),
      ['  const value = compute();', 'first();', '  const value = compute();'].join('\n')
    )
    const ctx = createMockContext(workspace)

    const result = await tool(ctx).handler({
      path: 'dup.js',
      oldText: ['const value = compute();', 'second();'].join('\n'),
      newText: 'x'
    })

    expect(result).toContain('Error')
    expect(result).toContain('The text to replace was not found')
    expect(result).not.toContain('actually says')
  })

  it('stays silent when the text really is gone', async () => {
    await writeFile(join(workspace, 'gone.js'), ['const a = 1;', 'const b = 2;'].join('\n'))
    const ctx = createMockContext(workspace)

    const result = await tool(ctx).handler({
      path: 'gone.js',
      oldText: 'const somethingEntirelyAbsent = 3;',
      newText: 'x'
    })

    expect(result).toContain('The text to replace was not found')
    expect(result).not.toContain('actually says')
  })

  it('still refuses the edit - this reports, it does not apply anything', async () => {
    await writeFile(join(workspace, 'draw.js'), source)
    const ctx = createMockContext(workspace)

    await tool(ctx).handler({
      path: 'draw.js',
      oldText: ['ctx.clearRect(0, 0, width, height);', 'ctx.fillStyle = accent;'].join('\n'),
      newText: 'WRECKED'
    })

    expect(await readFile(join(workspace, 'draw.js'), 'utf8')).toBe(source)
  })
})

describe('replace_lines places an edit its anchor identifies', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-relocate-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  function lineTool(ctx: ReturnType<typeof createMockContext>) {
    return replaceLinesTool(createMockDefine(), ctx) as unknown as {
      handler: (args: {
        path: string
        startLine: number
        endLine: number
        newText: string
        expectedFirstLine?: string
      }) => Promise<string>
    }
  }

  // The measured failure: a model composes several edits against one view of a
  // file; the first lands and shifts every line below it, and the rest arrive
  // with line numbers that are stale by exactly that shift.
  const shifted = [
    'import os',
    'import sys',
    'ADDED = 1',
    'ADDED = 2',
    'def draw(scene):',
    '    return scene',
    'def close(scene):',
    '    return None'
  ].join('\n')

  it('applies the edit where the anchor actually is, instead of refusing', async () => {
    await writeFile(join(workspace, 'a.py'), shifted)
    const ctx = createMockContext(workspace)

    // The model thinks `def draw(scene):` is on line 3; two lines were inserted
    // above it, so it is really on line 5.
    const result = await lineTool(ctx).handler({
      path: 'a.py',
      startLine: 3,
      endLine: 4,
      newText: ['def draw(scene, tint):', '    return tint'].join('\n'),
      expectedFirstLine: 'def draw(scene):'
    })

    expect(result).not.toContain('Error')
    const after = await readFile(join(workspace, 'a.py'), 'utf8')
    // The whole range moved by the same delta: the two `def draw` lines were
    // replaced, and the untouched neighbours survived.
    expect(after).toBe(
      [
        'import os',
        'import sys',
        'ADDED = 1',
        'ADDED = 2',
        'def draw(scene, tint):',
        '    return tint',
        'def close(scene):',
        '    return None'
      ].join('\n')
    )
  })

  it('says that it moved, so a wrong picture of the file gets corrected', async () => {
    await writeFile(join(workspace, 'a.py'), shifted)
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.py',
      startLine: 3,
      endLine: 4,
      newText: ['def draw(scene, tint):', '    return tint'].join('\n'),
      expectedFirstLine: 'def draw(scene):'
    })

    expect(result).toContain('stale by 2 line(s)')
    expect(result).toContain('line 5')
  })

  // The three refusals below are the bar this must not lower. Each one passes
  // before the relocation change as well as after it.
  it('still refuses when the anchor could mean several places', async () => {
    await writeFile(
      join(workspace, 'dup.py'),
      ['x = 1', '    return None', 'y = 2', '    return None', 'z = 3'].join('\n')
    )
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'dup.py',
      startLine: 1,
      endLine: 1,
      newText: 'WRECKED',
      expectedFirstLine: '    return None'
    })

    expect(result).toContain('Error')
    expect(result).toContain('does not match expectedFirstLine')
    expect(await readFile(join(workspace, 'dup.py'), 'utf8')).toContain('x = 1')
  })

  it('still refuses when the anchor text is genuinely gone', async () => {
    await writeFile(join(workspace, 'a.py'), ['x = 1', 'y = 2'].join('\n'))
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.py',
      startLine: 1,
      endLine: 1,
      newText: 'WRECKED',
      expectedFirstLine: 'def somethingRemoved():'
    })

    expect(result).toContain('Error')
    expect(await readFile(join(workspace, 'a.py'), 'utf8')).toBe(['x = 1', 'y = 2'].join('\n'))
  })

  it('still requires an anchor at all', async () => {
    await writeFile(join(workspace, 'a.py'), ['x = 1', 'y = 2'].join('\n'))
    const ctx = createMockContext(workspace)

    const result = await lineTool(ctx).handler({
      path: 'a.py',
      startLine: 1,
      endLine: 1,
      newText: 'WRECKED'
    })

    expect(result).toContain('Error')
    expect(result).toContain('expectedFirstLine is required')
    expect(await readFile(join(workspace, 'a.py'), 'utf8')).toBe(['x = 1', 'y = 2'].join('\n'))
  })

  it('keeps the seam guard on the relocated range, not the requested one', async () => {
    // The far end of the range is still protected after the move: repeating the
    // line that follows it is refused exactly as it would be in place.
    await writeFile(
      join(workspace, 'a.py'),
      ['pad', 'pad', 'first_call()', 'second_call()', 'total_mass = compute_total()'].join('\n')
    )
    const ctx = createMockContext(workspace)

    // `total_mass = compute_total()` already sits immediately after the moved
    // range, and it is substantial enough for the guard to care about.
    const result = await lineTool(ctx).handler({
      path: 'a.py',
      startLine: 1,
      endLine: 2,
      newText: ['first_call()', 'total_mass = compute_total()'].join('\n'),
      expectedFirstLine: 'first_call()'
    })

    expect(result).toContain('Error')
    expect(result).toContain('repeat a line')
  })
})

/**
 * A seam duplication is a stale view, and must earn the read back.
 *
 * `replace_lines` has two ways of telling the model its picture of the file is
 * wrong: a placement that cannot be anchored, and a replacement that would
 * repeat a neighbouring line. The first throws `StaleFileViewError` and buys a
 * read; the second threw a plain `Error` and bought nothing, though the seam
 * guard's own docstring describes exactly a stale view — "a model working from
 * a slightly stale view re-states the trailing context it thinks it is
 * preserving".
 *
 * That asymmetry matters where it is least affordable. Seen live: gemma-3-27B
 * at an 8,192-token window broke `triangles.py` with a `replace_lines`, leaving
 * an orphaned line at the wrong indent, and its repair attempt was refused by
 * this guard. A model already deep into a gathering streak gets no credit, so
 * the read that would show it the damage can itself be refused — the 76-refusal
 * failure `staleView.ts` exists to prevent.
 */
describe('a refused seam duplication buys a read back', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-seam-credit-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const SOURCE = [
    '    // Create planets',
    '    const planets = [];',
    '    const orbits = [];'
  ].join('\n')

  /** A distinct read, so nothing here is the loop guard's doing. */
  function look(
    ctx: ReturnType<typeof createMockContext>,
    name: string
  ): ReturnType<ReturnType<typeof createTaskLedger>['reviewCall']> {
    return ctx.ledger.reviewCall({
      name: 'read_file_range',
      kind: 'read',
      key: `{"path":"${name}"}`,
      args: { path: name },
      rereadable: true
    })
  }

  it('lets the model look again after the guard refuses its edit', async () => {
    await writeFile(join(workspace, 'a.js'), SOURCE)
    const ctx = createMockContext(workspace)

    // Deep into a gathering streak, where reads are refused outright.
    for (let i = 0; i < GATHERING_HARD_LIMIT + 1; i++) {
      ctx.ledger.recordOutcome({ kind: 'read', madeProgress: true })
    }
    expect(look(ctx, 'blocked.js').action).toBe('block')

    // Typed the way the seam tests above do it: the mock `define` hands back
    // an untyped handler, so an unannotated call yields `any`.
    const tool = replaceLinesTool(createMockDefine(), ctx) as unknown as {
      handler: (args: {
        path: string
        startLine: number
        endLine: number
        newText: string
        expectedFirstLine?: string
      }) => Promise<string>
    }
    const result = await tool.handler({
      path: 'a.js',
      startLine: 1,
      endLine: 1,
      newText: '    // Create planets and orbits\n    const planets = [];',
      expectedFirstLine: '// Create planets'
    })

    expect(result).toContain('already exists immediately after')
    // The refusal is Anodex's own evidence that the model cannot see the file
    // properly. Refusing the read that would fix that is backwards.
    expect(look(ctx, 'repair.js').action).toBe('run')
  })
})

/**
 * `edit_file` could not edit a CRLF file at all.
 *
 * The model reads a file, copies text out of it, and sends it back as
 * `oldText`. Line endings survive that trip inconsistently — a model that
 * reasons about the text rather than the bytes emits `\n` — so on a CRLF file
 * `original.split(oldText)` found nothing and the edit was refused with "the
 * text to replace was not found", every time, for any `oldText` spanning more
 * than one line.
 *
 * That is most of Windows, and any checkout with `core.autocrlf=true` on any
 * platform. `replace_lines` was unaffected, which is why this hid: the model
 * gets told to fall back to it and the run continues, a little worse, with
 * nothing reporting a bug.
 *
 * The file's own endings must survive the edit. Rewriting a CRLF file as LF
 * would turn a one-line change into a whole-file diff.
 */
describe('edit_file on a file with CRLF line endings', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-crlf-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const CRLF = ['function a() {', '  return 1', '}'].join('\r\n')

  function tool(ctx: ReturnType<typeof createMockContext>): {
    handler: (a: { path: string; oldText: string; newText: string }) => Promise<string>
  } {
    return editFileTool(createMockDefine(), ctx)
  }

  it('matches multi-line oldText written with plain newlines', async () => {
    await writeFile(join(workspace, 'a.ts'), CRLF, 'utf-8')
    const result = await tool(createMockContext(workspace)).handler({
      path: 'a.ts',
      oldText: 'function a() {\n  return 1\n}',
      newText: 'function a() {\n  return 42\n}'
    })
    expect(result).not.toContain('not found')
    expect(await readFile(join(workspace, 'a.ts'), 'utf-8')).toContain('return 42')
  })

  it('leaves the file still CRLF', async () => {
    // A one-line change that rewrites every ending is a whole-file diff, and
    // the user would see it as one.
    await writeFile(join(workspace, 'a.ts'), CRLF, 'utf-8')
    await tool(createMockContext(workspace)).handler({
      path: 'a.ts',
      oldText: 'function a() {\n  return 1\n}',
      newText: 'function a() {\n  return 42\n}'
    })
    const after = await readFile(join(workspace, 'a.ts'), 'utf-8')
    expect((after.match(/\r\n/g) ?? []).length).toBe(2)
    expect((after.match(/(?<!\r)\n/g) ?? []).length).toBe(0)
  })

  it('still matches oldText that already carries CRLF', async () => {
    await writeFile(join(workspace, 'a.ts'), CRLF, 'utf-8')
    const result = await tool(createMockContext(workspace)).handler({
      path: 'a.ts',
      oldText: 'function a() {\r\n  return 1\r\n}',
      newText: 'function a() {\r\n  return 7\r\n}'
    })
    expect(result).not.toContain('not found')
  })

  it('leaves an LF file exactly as it was', async () => {
    // The fix must not reach files that were never CRLF.
    const lf = ['function a() {', '  return 1', '}'].join('\n')
    await writeFile(join(workspace, 'a.ts'), lf, 'utf-8')
    await tool(createMockContext(workspace)).handler({
      path: 'a.ts',
      oldText: 'function a() {\n  return 1\n}',
      newText: 'function a() {\n  return 42\n}'
    })
    const after = await readFile(join(workspace, 'a.ts'), 'utf-8')
    expect(after).not.toContain('\r')
  })

  it('still refuses text that genuinely is not there', async () => {
    await writeFile(join(workspace, 'a.ts'), CRLF, 'utf-8')
    const result = await tool(createMockContext(workspace)).handler({
      path: 'a.ts',
      oldText: 'function zzz() {\n  return 0\n}',
      newText: 'x'
    })
    expect(result).toContain('not found')
  })
})
