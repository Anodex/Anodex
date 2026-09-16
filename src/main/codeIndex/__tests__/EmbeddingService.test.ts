import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  disposed: 0,
  loads: 0
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\app' }
}))

vi.mock('node:fs', () => ({ existsSync: () => true }))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: {
    getLlamaBackend: () =>
      Promise.resolve({
        loadModel: () => {
          mocks.loads += 1
          return Promise.resolve({
            embeddingVectorSize: 768,
            createEmbeddingContext: () =>
              Promise.resolve({
                getEmbeddingFor: () => Promise.resolve({ vector: [0.1, 0.2] }),
                dispose: () => {
                  mocks.disposed += 1
                  return Promise.resolve()
                }
              })
          })
        }
      })
  }
}))

const { embeddingService } = await import('../EmbeddingService')

/**
 * The code-search model used to stay in memory for the life of the app after one
 * search. Measured on the user's machine: a main process at 854MB with nothing saying
 * what was in it.
 */
describe('the code search model lets itself go when idle', () => {
  beforeEach(() => {
    mocks.disposed = 0
    mocks.loads = 0
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await embeddingService.release()
  })

  it('stays loaded while searches keep coming, and goes ten minutes after the last', async () => {
    await embeddingService.embed('a chunk of code')
    expect(embeddingService.isLoaded()).toBe(true)

    // Nine minutes on, another search: the countdown starts again rather than expiring.
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    await embeddingService.embed('another chunk')
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(embeddingService.isLoaded()).toBe(true)

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(embeddingService.isLoaded()).toBe(false)
    expect(mocks.disposed).toBe(1)
  })

  it('loads again for the next search', async () => {
    await embeddingService.embed('a chunk of code')
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(embeddingService.isLoaded()).toBe(false)

    const vector = await embeddingService.embed('a later chunk')

    expect(vector).toEqual([0.1, 0.2])
    expect(embeddingService.isLoaded()).toBe(true)
    expect(mocks.loads).toBe(2)
  })

  it('is safe to let go when it was never loaded', async () => {
    await embeddingService.release()
    expect(embeddingService.isLoaded()).toBe(false)
    expect(mocks.disposed).toBe(0)
  })
})
