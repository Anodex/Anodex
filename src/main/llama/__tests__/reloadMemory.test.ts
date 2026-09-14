import { freemem } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@shared/model.types'

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false } }))

const { describeInsufficientMemory } = await import('../LlamaService')

/** A GGUF read that fails, so the estimate uses its file-size fallback. */
const unreadable = {
  readGgufFileInfo: () => Promise.reject(new Error('not a real gguf'))
} as unknown as Parameters<typeof describeInsufficientMemory>[2]

const GB = 1024 ** 3

/**
 * A reload needs room for one copy of the model, not two: the copy loaded now is
 * unloaded before the new one loads.
 */
describe('describeInsufficientMemory', () => {
  // Just more than is free, so the answer turns on what the loaded model gives back.
  const model = (): ModelInfo => ({
    id: 'big',
    name: 'Big Model',
    path: 'C:/models/big.gguf',
    sizeBytes: Math.round((freemem() + 2 * GB) / 1.15),
    source: 'local'
  })

  it('refuses a model that does not fit in free memory', async () => {
    await expect(describeInsufficientMemory(model(), 8192, unreadable)).resolves.toMatch(
      /GB of RAM is free/
    )
  })

  it('counts the memory the loaded model will give back', async () => {
    await expect(describeInsufficientMemory(model(), 8192, unreadable, 8 * GB)).resolves.toBeNull()
  })
})
