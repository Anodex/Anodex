import { describe, expect, it } from 'vitest'
import { pickRecommendedContextSize, type ContextSizeCandidate } from '../contextRecommendation'

const GB = 1024 ** 3

const REQUIRED_BYTES: Record<number, number> = {
  2048: 0.5 * GB,
  4096: 1 * GB,
  8192: 2 * GB,
  16384: 4 * GB,
  32768: 8 * GB,
  65536: 16 * GB,
  131072: 32 * GB
}

/** Mimics a simple single-pool "does it fit" check, for readable test setup. */
function ladderFor(availableBytes: number): ContextSizeCandidate[] {
  return Object.entries(REQUIRED_BYTES).map(([contextSize, requiredBytes]) => ({
    contextSize: Number(contextSize),
    fits: requiredBytes <= availableBytes
  }))
}

describe('pickRecommendedContextSize', () => {
  it('picks the largest candidate that fits available memory', () => {
    const result = pickRecommendedContextSize(ladderFor(9 * GB), undefined)
    expect(result).toBe(32768)
  })

  it('picks the smallest candidate when memory is scarce', () => {
    const result = pickRecommendedContextSize(ladderFor(0.6 * GB), undefined)
    expect(result).toBe(2048)
  })

  it("caps the pick at the model's own trained context length, even with abundant memory", () => {
    const result = pickRecommendedContextSize(ladderFor(64 * GB), 16384)
    expect(result).toBe(16384)
  })

  it('does not cap when trainContextSize is unknown (undefined)', () => {
    const result = pickRecommendedContextSize(ladderFor(64 * GB), undefined)
    expect(result).toBe(131072)
  })

  it('falls back to the smallest candidate when nothing fits available memory', () => {
    const result = pickRecommendedContextSize(ladderFor(0.1 * GB), undefined)
    expect(result).toBe(2048)
  })

  it('falls back to the smallest overall candidate when the trained context is smaller than every option', () => {
    // No ladder entry is small enough to respect a 1,500-token trained max —
    // recommending nothing would be worse than the smallest available size.
    const result = pickRecommendedContextSize(ladderFor(64 * GB), 1500)
    expect(result).toBe(2048)
  })

  it('picks exactly the trained context size when it lands on a ladder value', () => {
    const result = pickRecommendedContextSize(ladderFor(64 * GB), 8192)
    expect(result).toBe(8192)
  })

  it('supports a dual-resource fit check (e.g. RAM and VRAM) via a precomputed `fits` flag', () => {
    // A candidate can fail on VRAM even though it would fit in RAM alone —
    // the caller is responsible for that combined check, not this function.
    const candidates: ContextSizeCandidate[] = [
      { contextSize: 16384, fits: true },
      { contextSize: 32768, fits: true },
      { contextSize: 65536, fits: false }, // fits in RAM but not VRAM, say
      { contextSize: 131072, fits: false }
    ]
    expect(pickRecommendedContextSize(candidates, undefined)).toBe(32768)
  })
})
