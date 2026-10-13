import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@shared/model.types'

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false } }))

const { largestFittingContextSize } = await import('../LlamaService')

const GB = 1024 ** 3
const LADDER = [4096, 8192, 16384, 32768, 65536, 131072, 262144]

/** 8 GB of weights, and 1 GB of context per 8,192 tokens. */
const gguf = (trainContextSize = 262144) =>
  ({
    readGgufFileInfo: () => Promise.resolve({}),
    GgufInsights: {
      from: () =>
        Promise.resolve({
          trainContextSize,
          estimateModelResourceRequirementsV2: () =>
            Promise.resolve({ cpuRam: 8 * GB, gpuVram: 0 }),
          estimateContextResourceRequirementsV2: ({ contextSize }: { contextSize: number }) =>
            Promise.resolve({ cpuRam: (contextSize / 8192) * GB, gpuVram: 0 })
        })
    }
  }) as unknown as Parameters<typeof largestFittingContextSize>[2]

const model: ModelInfo = {
  id: 'qwen',
  name: 'Qwen3.6-14B-A3B',
  path: 'C:/models/qwen.gguf',
  sizeBytes: 8 * GB,
  source: 'local'
}

describe('largestFittingContextSize', () => {
  it('stops at 32,768 however much is free, not at the model’s trained maximum', async () => {
    // Sized from total memory this model was asked for 262,144 tokens and refused.
    await expect(largestFittingContextSize(model, LADDER, gguf(), 64 * GB)).resolves.toBe(32768)
  })

  it('picks the largest size the preflight would accept now', async () => {
    // 8 GB + 2 GB at 16,384 is 11.5 GB with the margin; 32,768 would need 13.8 GB.
    await expect(largestFittingContextSize(model, LADDER, gguf(), 12 * GB)).resolves.toBe(16384)
  })

  it('never goes past what the model was trained for', async () => {
    await expect(largestFittingContextSize(model, LADDER, gguf(8192), 64 * GB)).resolves.toBe(8192)
  })

  it('gives up below 8,192 rather than sizing a model down to uselessness', async () => {
    await expect(largestFittingContextSize(model, LADDER, gguf(), 9 * GB)).resolves.toBeNull()
  })
})
