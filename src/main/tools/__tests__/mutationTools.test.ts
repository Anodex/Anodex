import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolCall, ToolConfirmRequest } from '@shared/tools.types'
import {
  deleteFileTool,
  editFileTool,
  moveFileTool,
  patchFileTool,
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
    const ctx = createMockContext(workspace)
    const capture = captureCalls<ToolCall>()
    ctx.emit = capture.emit
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }

    await tool.handler({ path: 'huge.txt', content: 'x'.repeat(60_000) })

    const success = capture.calls.find((c) => c.status === 'success')
    expect(success?.diff).toBeUndefined()
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
