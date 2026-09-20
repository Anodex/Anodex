import { describe, expect, it } from 'vitest'
import {
  isModelHardwareCompatible,
  contextSizeFor,
  recommendModel as findRecommendedModel,
  type HardwareProfile
} from '../modelRecommendation'
import { tierMemory } from '../modelMemory'
import type { ModelTier } from '../recommendedModels'

const GB = 1024 ** 3

function recommendModel(hardware: HardwareProfile) {
  const recommendation = findRecommendedModel(hardware)
  if (!recommendation) throw new Error('Expected a compatible recommendation')
  return recommendation
}

/** Every rung, smallest first. */
const LADDER: ModelTier[] = ['1b', '3b', '7b', '14b', '32b', '70b']

/**
 * What size of model suits a machine.
 *
 * This used to pick a named model out of a hand-written catalog, and the
 * cases here were written against that catalog's RAM figures — which turned
 * out to be two to three times what a model actually needs. The catalog is
 * gone (see `shared/recommendedModels.ts`); what is left is the part that was
 * doing the work, a ladder of size classes matched against memory.
 *
 * So these are anchored to `tierMemory` rather than to hard-coded gigabytes.
 * A future recalibration should move the cases with it instead of quietly
 * leaving them testing a different band than their names claim.
 */
describe('recommendModel', () => {
  it('offers nothing to a machine below the smallest rung', () => {
    const belowSmallest = tierMemory('1b').minRamGb - 1
    expect(
      findRecommendedModel({ ramBytes: belowSmallest * GB, vramBytes: null, unified: false })
    ).toBeNull()
  })

  it.each(LADDER)('suggests %s to a machine sized exactly for it', (tier) => {
    // At a rung's own minimum that rung is the answer: it is the largest that
    // fits, and the next one up is always further away.
    const { minRamGb } = tierMemory(tier)
    // The 70B rung is withheld from CPU-only machines, so give this one a card.
    const rec = recommendModel({ ramBytes: minRamGb * GB, vramBytes: 24 * GB, unified: false })
    expect(rec.tier).toBe(tier)
  })

  it('never suggests a rung the machine cannot hold', () => {
    for (let ramGb = 4; ramGb <= 256; ramGb += 1) {
      const rec = findRecommendedModel({ ramBytes: ramGb * GB, vramBytes: null, unified: false })
      if (!rec) continue
      expect(tierMemory(rec.tier).minRamGb).toBeLessThanOrEqual(ramGb)
    }
  })

  it('only ever moves up as a machine gets bigger', () => {
    // A ladder that goes backwards somewhere is a bug no single case shows.
    let previous = -1
    for (let ramGb = 4; ramGb <= 256; ramGb += 1) {
      const rec = findRecommendedModel({ ramBytes: ramGb * GB, vramBytes: 24 * GB, unified: false })
      if (!rec) continue
      const rung = LADDER.indexOf(rec.tier)
      expect(rung).toBeGreaterThanOrEqual(previous)
      previous = rung
    }
  })

  it('says so when a rung fits without room to spare', () => {
    // Comfort is advisory, not a gate — using it as a ceiling made the ladder
    // step *down* as a machine got bigger, because a smaller rung could
    // become comfortable while a larger one still only fitted. So a rung
    // between its minimum and its ideal is still the answer, with a caveat.
    const tight = tierMemory('14b').minRamGb
    expect(tight).toBeLessThan(tierMemory('14b').idealRamGb)
    const rec = recommendModel({ ramBytes: tight * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('14b')
    expect(rec.rationale).toContain('only just')
  })

  it('drops the caveat once there is real room', () => {
    const roomy = tierMemory('14b').idealRamGb
    const rec = recommendModel({ ramBytes: roomy * GB, vramBytes: null, unified: false })
    expect(rec.rationale).not.toContain('only just')
    expect(rec.rationale).toContain('comfortably')
  })

  it('withholds the 70B rung from a machine with no graphics memory', () => {
    // It loads on a large enough machine and produces a couple of tokens a
    // second, which is not a recommendation.
    const huge = tierMemory('70b').idealRamGb * 2
    expect(recommendModel({ ramBytes: huge * GB, vramBytes: null, unified: false }).tier).toBe(
      '32b'
    )
    expect(recommendModel({ ramBytes: huge * GB, vramBytes: 48 * GB, unified: false }).tier).toBe(
      '70b'
    )
    expect(recommendModel({ ramBytes: huge * GB, vramBytes: null, unified: true }).tier).toBe('70b')
  })

  it('always uses auto GPU offload', () => {
    const rec = recommendModel({ ramBytes: 16 * GB, vramBytes: 8 * GB, unified: false })
    expect(rec.gpuLayers).toBe('auto')
  })

  it('mentions dedicated VRAM in the rationale, but not on unified memory', () => {
    const dedicated = recommendModel({ ramBytes: 32 * GB, vramBytes: 12 * GB, unified: false })
    expect(dedicated.rationale).toContain('VRAM')

    // On unified memory the graphics memory *is* the RAM already counted, so
    // naming it again would describe the same gigabytes twice.
    const unified = recommendModel({ ramBytes: 32 * GB, vramBytes: 32 * GB, unified: true })
    expect(unified.rationale).not.toContain('VRAM')
  })
})

describe('contextSizeFor', () => {
  it('grows the context with memory on the large rungs', () => {
    expect(contextSizeFor('32b', 32)).toBe(16384)
    expect(contextSizeFor('32b', 67)).toBe(32768)
    expect(contextSizeFor('32b', 131)).toBe(65536)
    expect(contextSizeFor('32b', 259)).toBe(131072)
  })

  it('counts dedicated VRAM toward context headroom, not just RAM', () => {
    // A real reported case: 63.1 GB of RAM alone isn't enough headroom to
    // reach the next rung, but a 55.8 GB card sitting right there was being
    // ignored entirely for context sizing, even though it can easily host a
    // much bigger KV cache.
    expect(contextSizeFor('32b', 63.1)).toBe(16384)
    expect(contextSizeFor('32b', 63.1, 55.8)).toBe(32768)
  })

  it('does not double-count unified memory', () => {
    // `recommendModel` passes 0 for `vramGb` on unified machines because the
    // same physical memory is already in `ramGb`.
    const rec = recommendModel({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB, unified: true })
    expect(rec.contextSize).toBe(16384)
  })

  it('keeps a small machine on a small context', () => {
    expect(contextSizeFor('1b', 4)).toBe(2048)
    expect(contextSizeFor('3b', 8)).toBe(4096)
    expect(contextSizeFor('7b', 16)).toBe(8192)
  })
})

describe('isModelHardwareCompatible', () => {
  const model = {
    id: 'test',
    name: 'Test',
    family: 'qwen' as const,
    tier: '70b' as const,
    description: 'test',
    approxSize: '42.5 GB',
    minRam: '54 GB',
    minRamGb: 54,
    idealRamGb: 65,
    downloadUrl: 'https://example.invalid/test.gguf',
    tags: [],
    primaryUse: 'general' as const,
    requiresGpuRecommended: true,
    minVramGb: 24
  }

  it('withholds a GPU-recommended model when the graphics memory is not there', () => {
    expect(
      isModelHardwareCompatible(model, { ramBytes: 128 * GB, vramBytes: null, unified: false })
    ).toBe(false)
    expect(
      isModelHardwareCompatible(model, { ramBytes: 128 * GB, vramBytes: 48 * GB, unified: false })
    ).toBe(true)
  })

  it('refuses a model above the machine’s RAM whatever its GPU', () => {
    expect(
      isModelHardwareCompatible(model, { ramBytes: 16 * GB, vramBytes: 48 * GB, unified: false })
    ).toBe(false)
  })
})
