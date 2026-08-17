import { describe, expect, it } from 'vitest'
import {
  MIN_WORKING_SET_FRACTION,
  allocateContextBudget,
  workingSetFraction
} from '../contextBudget'
import { CONTEXT_SIZE_LADDER } from '../contextSizes'

describe('allocateContextBudget', () => {
  // The whole point of the module: it has to hold across nine doublings, from a
  // laptop to a half-terabyte workstation, with no per-size special cases.
  describe('scales across every window Anodex exposes', () => {
    it.each(CONTEXT_SIZE_LADDER)('keeps the working set viable at %i', (size) => {
      const allocation = allocateContextBudget(size)
      expect(workingSetFraction(allocation)).toBeGreaterThanOrEqual(MIN_WORKING_SET_FRACTION)
      expect(allocation.workingSet).toBeGreaterThan(0)
    })

    it.each(CONTEXT_SIZE_LADDER)('never allocates more than the window at %i', (size) => {
      const a = allocateContextBudget(size)
      const total = a.outputReserve + a.referenceContext + a.toolSchemas + a.repoMap + a.workingSet
      expect(total).toBeLessThanOrEqual(size)
    })

    it('gives a larger window a larger working set, monotonically', () => {
      const sets = CONTEXT_SIZE_LADDER.map((size) => allocateContextBudget(size).workingSet)
      for (let i = 1; i < sets.length; i++) expect(sets[i]).toBeGreaterThan(sets[i - 1])
    })
  })

  // The measured failure this module answers: a 16,384 window whose fixed
  // overhead reached 79%, leaving ~3,300 tokens for the actual task.
  it('leaves the measured 16,384 window about half its space for the task', () => {
    const allocation = allocateContextBudget(16384)
    expect(allocation.workingSet).toBe(8521)
    expect(workingSetFraction(allocation)).toBeGreaterThan(0.5)
    expect(allocation.constrained).toBe(false)
  })

  describe('the small end, where floors would overflow the window', () => {
    // Floors sum to 2,304 before the repo map — more than the window itself.
    it('scales floors back rather than returning a negative working set', () => {
      const allocation = allocateContextBudget(2048)
      expect(allocation.constrained).toBe(true)
      expect(allocation.workingSet).toBeGreaterThan(0)
      expect(workingSetFraction(allocation)).toBeGreaterThanOrEqual(MIN_WORKING_SET_FRACTION)
    })

    it('still reserves some room for a reply', () => {
      expect(allocateContextBudget(2048).outputReserve).toBeGreaterThan(0)
    })

    it('does not flag a comfortable window as constrained', () => {
      expect(allocateContextBudget(8192).constrained).toBe(false)
    })

    it('survives a zero window without dividing by zero', () => {
      const allocation = allocateContextBudget(0)
      expect(allocation.workingSet).toBe(0)
      expect(workingSetFraction(allocation)).toBe(0)
      expect(Number.isNaN(allocation.maskAtTokens)).toBe(false)
    })
  })

  describe('the large end, where fractions would be wasteful', () => {
    // A 1M window taking 15% for the system prompt would reserve 157,286 tokens
    // for text that has nothing more to say.
    it('caps overhead so a huge window spends it on the task', () => {
      const allocation = allocateContextBudget(1048576)
      expect(allocation.outputReserve).toBe(4096)
      expect(allocation.referenceContext).toBe(8192)
      expect(allocation.toolSchemas).toBe(6144)
      expect(allocation.repoMap).toBe(4096)
      expect(workingSetFraction(allocation)).toBeGreaterThan(0.97)
    })

    it('has no upper bound of its own', () => {
      const beyond = allocateContextBudget(4_194_304)
      expect(beyond.workingSet).toBeGreaterThan(allocateContextBudget(1048576).workingSet)
    })
  })

  describe('masking and rotation thresholds', () => {
    it('fires proportionally, not at a constant', () => {
      const small = allocateContextBudget(8192)
      const large = allocateContextBudget(131072)
      expect(large.maskAtTokens).toBeGreaterThan(small.maskAtTokens * 10)
    })

    it('always begins masking before rotating', () => {
      for (const size of CONTEXT_SIZE_LADDER) {
        const allocation = allocateContextBudget(size)
        expect(allocation.maskAtTokens).toBeLessThan(allocation.rotateAtTokens)
      }
    })

    it('rotates before the input limit, not at it', () => {
      const allocation = allocateContextBudget(32768)
      expect(allocation.rotateAtTokens).toBeLessThan(
        allocation.contextSize - allocation.outputReserve
      )
    })
  })

  it('returns whole tokens only', () => {
    const allocation = allocateContextBudget(12345)
    for (const value of Object.values(allocation)) {
      if (typeof value === 'number') expect(Number.isInteger(value)).toBe(true)
    }
  })
})
