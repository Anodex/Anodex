import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolCall, ToolConfirmRequest } from '@shared/tools.types'
import { editFileTool, writeFileTool } from '../mutationTools'
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
