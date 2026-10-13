import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@shared/model.types'

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false } }))

const { describeBusyGpu } = await import('../LlamaService')

const GB = 1024 ** 3

/** A GGUF whose weights take 14 GB of GPU memory and whose context takes 4 GB. */
const gguf = {
  readGgufFileInfo: () => Promise.resolve({}),
  GgufInsights: {
    from: () =>
      Promise.resolve({
        totalLayers: 64,
        estimateModelResourceRequirementsV2: ({ gpuLayers }: { gpuLayers: number }) =>
          Promise.resolve({ gpuVram: (14 * GB * gpuLayers) / 64, cpuRam: 0 }),
        estimateContextResourceRequirementsV2: () => Promise.resolve({ gpuVram: 4 * GB, cpuRam: 0 })
      })
  }
} as unknown as Parameters<typeof describeBusyGpu>[3]

const model: ModelInfo = {
  id: 'big',
  name: 'Qwen3.8-27B',
  path: 'C:/models/qwen.gguf',
  sizeBytes: 17 * GB,
  source: 'local'
}

describe('describeBusyGpu', () => {
  it('backs off when another program holds the memory the model needs', async () => {
    // The roadmap's case: voice training held about 10 GB of a 24 GB card.
    const message = await describeBusyGpu(model, 8192, 'auto', gguf, {
      total: 24 * GB,
      used: 10 * GB,
      free: 14 * GB
    })
    expect(message).toMatch(/Another program is using 10\.0 GB/)
    expect(message).toMatch(/needs about 18\.0 GB there and 14\.0 GB is free/)
  })

  it('goes ahead when the card has room', async () => {
    await expect(
      describeBusyGpu(model, 8192, 'auto', gguf, { total: 24 * GB, used: 1 * GB, free: 23 * GB })
    ).resolves.toBeNull()
  })

  it('leaves a model too big for even an idle card to the engine’s partial offload', async () => {
    await expect(
      describeBusyGpu(model, 8192, 'auto', gguf, { total: 12 * GB, used: 1 * GB, free: 11 * GB })
    ).resolves.toBeNull()
  })

  it('counts only the layers asked for', async () => {
    // Half the layers: 7 GB of weights plus 4 GB of context fits in 14 GB free.
    await expect(
      describeBusyGpu(model, 8192, 32, gguf, { total: 24 * GB, used: 10 * GB, free: 14 * GB })
    ).resolves.toBeNull()
  })

  it('never blocks a CPU-only load or one whose GPU reading failed', async () => {
    const busy = { total: 24 * GB, used: 20 * GB, free: 4 * GB }
    await expect(describeBusyGpu(model, 8192, 0, gguf, busy)).resolves.toBeNull()
    await expect(describeBusyGpu(model, 8192, 'auto', gguf, null)).resolves.toBeNull()
  })
})
