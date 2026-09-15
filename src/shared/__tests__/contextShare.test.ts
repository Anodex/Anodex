import { describe, expect, it } from 'vitest'
import { contextPerJob, jobsThatFit, MIN_CONTEXT_PER_JOB } from '../contextShare'

/**
 * Two long jobs sharing a 65,536-token pool each planned against all of it, and
 * both failed on the same token — 26,651 + 38,886 in the stress test.
 */
describe('contextShare', () => {
  it('gives each job an equal share, so every job together fits the pool', () => {
    expect(contextPerJob(65536, 2)).toBe(32768)
    expect(contextPerJob(65536, 3) * 3).toBeLessThanOrEqual(65536)
    expect(contextPerJob(65536, 1)).toBe(65536)
  })

  it('runs fewer jobs rather than giving any of them an unusable share', () => {
    expect(jobsThatFit(3, 65536)).toBe(3)
    expect(jobsThatFit(3, 16384)).toBe(2)
    expect(jobsThatFit(2, 8192)).toBe(1)
    expect(jobsThatFit(2, MIN_CONTEXT_PER_JOB - 1)).toBe(1)
  })

  it('reads a missing or odd job count as one', () => {
    expect(jobsThatFit(0, 65536)).toBe(1)
    expect(contextPerJob(65536, 0)).toBe(65536)
  })
})
