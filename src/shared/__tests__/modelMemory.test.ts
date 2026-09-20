import { describe, expect, it } from 'vitest'
import { estimateRamRequirements, tierMemory } from '../modelMemory'

describe('estimateRamRequirements', () => {
  /**
   * Real llama.cpp load reports, all at an 8192 context, taken off this
   * project's own machine. `total` is every buffer the report lists: weights,
   * KV cache, recurrent state, compute and output.
   */
  const MEASURED = [
    { name: 'Qwen3-4B Q4_K_M', fileGb: 2.33, totalGb: 3.85 },
    { name: 'Devstral-Small 23.6B Q4_K_M', fileGb: 13.35, totalGb: 14.9 },
    { name: 'Qwen3.8-27B Q4_K_M', fileGb: 15.33, totalGb: 16.1 }
  ]

  it.each(MEASURED)('leaves $name room to run and room for the OS', ({ fileGb, totalGb }) => {
    const { minRamGb } = estimateRamRequirements(fileGb * 1024 ** 3)
    // Above what the model actually takes...
    expect(minRamGb).toBeGreaterThan(totalGb)
    // ...with at least two gigabytes over for the operating system, since
    // this is compared against total RAM rather than free RAM.
    expect(minRamGb - totalGb).toBeGreaterThanOrEqual(2)
  })

  it.each(MEASURED)('does not price $name out of a machine that fits it', ({ fileGb, totalGb }) => {
    const { minRamGb } = estimateRamRequirements(fileGb * 1024 ** 3)
    // The old estimate was `size * 2.8 + 3`, which asked 49GB for a model
    // needing 16 and left a 32GB gaming PC with nothing but 3B models. Twice
    // the real requirement is the line: past it, ordinary machines start
    // being told they cannot run what they can.
    expect(minRamGb).toBeLessThan(totalGb * 2)
  })

  it('still lets a 4GB machine hold a 1B model', () => {
    // At a flat +5 of headroom the smallest model in the catalog needed 6GB
    // and the smallest machine was offered nothing at all, which is worse
    // than offering it the one thing it can just about hold.
    const { minRamGb } = estimateRamRequirements(0.8 * 1024 ** 3)
    expect(minRamGb).toBeLessThanOrEqual(4)
  })

  it('idealRamGb is always at least minRamGb', () => {
    const { minRamGb, idealRamGb } = estimateRamRequirements(10 * 1024 ** 3)
    expect(idealRamGb).toBeGreaterThanOrEqual(minRamGb)
  })
})

describe('tierMemory', () => {
  it('asks more of the machine at every rung', () => {
    const rungs = ['1b', '3b', '7b', '14b', '32b', '70b'] as const
    for (let i = 1; i < rungs.length; i += 1) {
      expect(tierMemory(rungs[i]).minRamGb).toBeGreaterThan(tierMemory(rungs[i - 1]).minRamGb)
      expect(tierMemory(rungs[i]).idealRamGb).toBeGreaterThan(tierMemory(rungs[i - 1]).idealRamGb)
    }
  })

  it('judges a tier on the same rule as a real model file', () => {
    // A tier is a stand-in for a file of that size, so the two answers have
    // to agree — otherwise the machine is measured one way when it is offered
    // a specific model and another way when it is offered a tier.
    expect(tierMemory('14b')).toEqual(estimateRamRequirements(9.0 * 1024 ** 3))
  })

  it('keeps the smallest rung inside the smallest machine', () => {
    expect(tierMemory('1b').minRamGb).toBeLessThanOrEqual(4)
  })
})
