import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateImageTool } from '../imageGenerationTool'
import {
  captureCalls,
  captureConfirmations,
  createMockContext,
  createMockDefine
} from './test-helpers'

const generatedImage = {
  path: 'Generated in this conversation',
  name: 'OpenAI generated image',
  mimeType: 'image/png',
  sizeBytes: 12,
  dataUrl: 'data:image/png;base64,iVBORw0KGgo='
}

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  saveVisualPreviewAsset: vi.fn()
}))

vi.mock('../../imageGeneration/ImageGenerationService', () => ({
  generateImage: mocks.generateImage
}))

vi.mock('../visualPreviewAssets', () => ({
  saveVisualPreviewAsset: mocks.saveVisualPreviewAsset
}))

vi.mock('../../projects/ProjectMemoryStore', () => ({
  projectMemoryStore: { recordTouch: vi.fn() }
}))

describe('generate_image', () => {
  beforeEach(() => {
    mocks.generateImage.mockReset().mockResolvedValue(generatedImage)
    mocks.saveVisualPreviewAsset
      .mockReset()
      .mockResolvedValue({ conversationId: 'test-conversation', id: 'generated.png' })
  })

  it('always shows the billable prompt for explicit approval, then renders a durable preview', async () => {
    const capture = captureCalls()
    const confirmations = captureConfirmations()
    const ctx = {
      ...createMockContext('/workspace'),
      imageGeneration: { provider: 'openai' as const },
      emit: capture.emit,
      confirm: confirmations.confirm
    }
    const tool = generateImageTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { prompt: string; aspect_ratio: '16:9'; quality: 'high' }) => Promise<string>
    }

    await expect(
      tool.handler({
        prompt: 'A modern desktop app dashboard, dark blue palette.',
        aspect_ratio: '16:9',
        quality: 'high'
      })
    ).resolves.toContain('Generated one 16:9 image with OpenAI')

    expect(confirmations.requests).toHaveLength(1)
    expect(confirmations.requests[0]).toMatchObject({
      toolName: 'generate_image',
      kind: 'web',
      risk: 'sensitive',
      requiresHumanApproval: true
    })
    expect(confirmations.requests[0].detail).toContain('A modern desktop app dashboard')
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', aspectRatio: '16:9', quality: 'high' })
    )
    expect(capture.calls.at(-1)?.preview).toMatchObject({
      kind: 'image',
      source: 'generated',
      prompt: 'A modern desktop app dashboard, dark blue palette.',
      asset: { conversationId: 'test-conversation', id: 'generated.png' }
    })
  })

  it('does not reach a cloud API when the user declines', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      imageGeneration: { provider: 'google' as const },
      confirm: () => Promise.resolve({ approved: false })
    }
    const tool = generateImageTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { prompt: string }) => Promise<string>
    }

    await expect(tool.handler({ prompt: 'A friendly robot.' })).resolves.toContain('denied')
    expect(mocks.generateImage).not.toHaveBeenCalled()
  })
})
