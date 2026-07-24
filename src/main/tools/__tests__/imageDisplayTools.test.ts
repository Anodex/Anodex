import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showImageTool } from '../imageDisplayTools'
import { captureCalls, createMockContext, createMockDefine } from './test-helpers'

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from('displayed-pixels')
])

const assetMocks = vi.hoisted(() => ({
  saveImage: vi.fn<() => Promise<string>>()
}))

vi.mock('../../projects/ProjectMemoryStore', () => ({
  projectMemoryStore: { recordTouch: vi.fn() }
}))

vi.mock('../../conversations/ConversationAssetStore', () => ({
  conversationAssetStore: { saveImage: assetMocks.saveImage }
}))

describe('show_image', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-show-image-'))
    assetMocks.saveImage.mockReset().mockResolvedValue('test-message-image.png')
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('shows a workspace image without requiring a visual provider queue', async () => {
    await writeFile(join(workspace, 'result.png'), PNG)
    const capture = captureCalls()
    const ctx = { ...createMockContext(workspace), emit: capture.emit }
    const tool = showImageTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'result.png' })

    expect(ctx.visualInputs).toBeUndefined()
    expect(result).toContain('Displayed "result.png"')
    expect(capture.calls.find((call) => call.status === 'success')?.preview).toMatchObject({
      kind: 'image',
      source: 'assistant',
      title: 'result.png',
      path: 'result.png',
      mimeType: 'image/png',
      asset: {
        conversationId: 'test-conversation',
        id: 'test-message-image.png'
      }
    })
  })

  it('rejects paths outside the workspace', async () => {
    const capture = captureCalls()
    const tool = showImageTool(createMockDefine(), {
      ...createMockContext(workspace),
      emit: capture.emit
    }) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    await expect(tool.handler({ path: '../outside.png' })).resolves.toContain('Error:')
    expect(capture.calls.at(-1)).toMatchObject({ status: 'error' })
  })
})
