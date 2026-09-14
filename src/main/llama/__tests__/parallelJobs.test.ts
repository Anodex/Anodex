import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false } }))

const { clampParallelJobs, MAX_PARALLEL_JOBS } = await import('../LlamaService')

describe('clampParallelJobs', () => {
  it('reads a missing or unusable setting as one job at a time', () => {
    expect(clampParallelJobs(undefined)).toBe(1)
    expect(clampParallelJobs(Number.NaN)).toBe(1)
    expect(clampParallelJobs(0)).toBe(1)
  })

  it('keeps a real choice and caps it', () => {
    expect(clampParallelJobs(2)).toBe(2)
    expect(clampParallelJobs(3)).toBe(3)
    expect(clampParallelJobs(8)).toBe(MAX_PARALLEL_JOBS)
    expect(clampParallelJobs(2.7)).toBe(2)
  })
})
