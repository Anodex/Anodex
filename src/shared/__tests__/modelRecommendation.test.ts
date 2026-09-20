import { describe, expect, it } from 'vitest'
import {
  isModelHardwareCompatible,
  recommendModel as findRecommendedModel,
  type HardwareProfile
} from '../modelRecommendation'
import { RECOMMENDED_MODELS } from '../recommendedModels'

const GB = 1024 ** 3

function recommendedModelMinRam(modelId: string): number {
  return RECOMMENDED_MODELS.find((model) => model.id === modelId)!.minRamGb
}

function recommendModel(hardware: HardwareProfile) {
  const recommendation = findRecommendedModel(hardware)
  if (!recommendation) throw new Error('Expected a compatible recommendation')
  return recommendation
}

describe('recommendModel', () => {
  it('recommends a 1B model on 4 GB RAM with the smallest context', () => {
    const rec = recommendModel({ ramBytes: 4 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('1b')
    expect(rec.modelId).toBe('llama-3.2-1b-q4')
    expect(rec.contextSize).toBe(2048)
  })

  it('recommends a 3B coding model on 8 GB RAM with a small context', () => {
    const rec = recommendModel({ ramBytes: 8 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('3b')
    expect(rec.modelId).toBe('qwen2.5-coder-3b-q4')
    expect(rec.contextSize).toBe(4096)
  })

  it('recommends a 14B coding model on 16 GB RAM', () => {
    // This was a 7B until the catalog's RAM figures were measured against
    // real llama.cpp load reports. A 14B Q4 is a 9 GB file that needs about
    // 10 GB loaded, so 16 GB holds it with the operating system's own working
    // set to spare — the old catalog claimed it needed 32 GB, which is where
    // the 7B answer came from. Anodex recommends the most capable model that
    // fits; how fast it then runs is the "Fastest" card's question.
    const rec = recommendModel({ ramBytes: 16 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('14b')
    expect(rec.modelId).toBe('qwen2.5-coder-14b-q4')
    expect(rec.contextSize).toBe(16384)
  })

  it('recommends a 7B model on a machine too small for anything larger', () => {
    // 9 GB clears the 7B minimum and misses 14B's by five, so this is the
    // band where the 7B is genuinely the best that fits.
    expect(recommendedModelMinRam('qwen3-8b-q4')).toBeLessThanOrEqual(9)
    expect(recommendedModelMinRam('qwen2.5-coder-14b-q4')).toBeGreaterThan(9)
    const rec = recommendModel({ ramBytes: 9 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('7b')
  })

  it('recommends a 14B coding model on 32 GB RAM', () => {
    const rec = recommendModel({ ramBytes: 32 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('14b')
    expect(rec.modelId).toBe('qwen2.5-coder-14b-q4')
    expect(rec.contextSize).toBe(16384)
  })

  it('does not recommend 32B below the catalog RAM minimum', () => {
    // Anchored to the catalog rather than a hard-coded figure, so a future
    // recalibration moves the case with it instead of silently testing a
    // different band.
    const belowMinimum = recommendedModelMinRam('qwen2.5-coder-32b-q4') - 1
    const rec = recommendModel({ ramBytes: belowMinimum * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('14b')
    expect(rec.modelId).toBe('qwen2.5-coder-14b-q4')
  })

  it("prefers 14B over 32B at exactly 32B's RAM minimum with no GPU", () => {
    // The bare minimum for 32B is zero headroom, while the same machine is
    // past 14B's own "ideal" point. Without a GPU to make 32B's slower
    // CPU-only inference worthwhile, 14B is the more comfortable, reliable
    // pick — meeting a model's stated minimum isn't the same as it being the
    // best choice once a smaller model is more comfortably suited.
    const atMinimum = recommendedModelMinRam('qwen2.5-coder-32b-q4')
    const rec = recommendModel({ ramBytes: atMinimum * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('14b')
    expect(rec.modelId).toBe('qwen2.5-coder-14b-q4')
  })

  it('switches to 32B once RAM reaches its own ideal point, even without a GPU', () => {
    const rec = recommendModel({ ramBytes: 64 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('32b')
    expect(rec.modelId).toBe('qwen2.5-coder-32b-q4')
    expect(rec.contextSize).toBe(16384)
  })

  it('does not grow context just below the next headroom threshold', () => {
    const rec = recommendModel({ ramBytes: 66 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('32b')
    expect(rec.contextSize).toBe(16384)
  })

  it('grows context on a large workstation (64 GB of usable headroom)', () => {
    const rec = recommendModel({ ramBytes: 67 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('32b')
    expect(rec.contextSize).toBe(32768)
  })

  it('counts dedicated VRAM toward context headroom, not just RAM', () => {
    // A real reported case: 63.1 GB of RAM alone isn't enough headroom to
    // reach the next context tier — but a 55.8 GB dedicated GPU sitting right
    // there was being ignored entirely for context sizing, even though it can
    // easily host a much bigger KV cache. The tier is the same either way now
    // that the catalog's RAM figures are measured; what the GPU changes, and
    // what this pins, is the context size growing rather than staying at
    // 16,384.
    const ramOnly = recommendModel({ ramBytes: 63.1 * GB, vramBytes: null, unified: false })
    expect(ramOnly.contextSize).toBe(16384)

    const withGpu = recommendModel({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB, unified: false })
    expect(withGpu.tier).toBe('32b')
    expect(withGpu.contextSize).toBe(32768)
  })

  it('does not double-count VRAM on unified memory (it is already part of ramBytes there)', () => {
    const rec = recommendModel({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB, unified: true })
    expect(rec.contextSize).toBe(16384)
  })

  it('grows context further on a very large workstation (128 GB of usable headroom)', () => {
    const rec = recommendModel({ ramBytes: 131 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('32b')
    expect(rec.contextSize).toBe(65536)
  })

  it('reaches the context ceiling on an extreme workstation (256 GB of usable headroom)', () => {
    const rec = recommendModel({ ramBytes: 259 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('32b')
    expect(rec.contextSize).toBe(131072)
  })

  it('does not recommend 70B below the catalog RAM minimum', () => {
    const rec = recommendModel({ ramBytes: 83 * GB, vramBytes: null, unified: false })
    expect(rec.modelId).not.toBe('llama-3.3-70b-q4')
    expect(rec.tier).toBe('32b')
  })

  it('keeps the 32B coder as the default on a 96 GB workstation because Anodex is coding-first', () => {
    const rec = recommendModel({ ramBytes: 96 * GB, vramBytes: 48 * GB, unified: false })
    expect(rec.tier).toBe('32b')
    expect(rec.modelId).toBe('qwen2.5-coder-32b-q4')
  })

  it('recommends a 32B model on a 64 GB RAM / 55 GB VRAM workstation', () => {
    const rec = recommendModel({ ramBytes: 64 * GB, vramBytes: 55 * GB, unified: false })
    expect(rec.tier).toBe('32b')
  })

  it('never selects a model above its catalog RAM minimum', () => {
    const ramGbCases = [4, 8, 16, 32, 43, 48, 64, 83, 96]

    for (const ramGb of ramGbCases) {
      const rec = recommendModel({ ramBytes: ramGb * GB, vramBytes: null, unified: false })
      expect(recommendedModelMinRam(rec.modelId)).toBeLessThanOrEqual(ramGb)
    }
  })

  it('always uses auto GPU offload', () => {
    const rec = recommendModel({ ramBytes: 16 * GB, vramBytes: 8 * GB, unified: false })
    expect(rec.gpuLayers).toBe('auto')
  })

  it('mentions dedicated VRAM in the rationale, but not on unified memory', () => {
    const dedicated = recommendModel({ ramBytes: 32 * GB, vramBytes: 12 * GB, unified: false })
    expect(dedicated.rationale).toContain('VRAM')

    const unified = recommendModel({ ramBytes: 32 * GB, vramBytes: 32 * GB, unified: true })
    expect(unified.rationale).not.toContain('VRAM')
  })

  it('does not call a general chat model a coder model in the rationale', () => {
    const rec = recommendModel({ ramBytes: 4 * GB, vramBytes: null, unified: false })
    expect(rec.modelId).toBe('llama-3.2-1b-q4')
    expect(rec.rationale).toContain('general chat')
    expect(rec.rationale).not.toContain('coder model')
  })

  it('does not recommend an oversized model below the smallest supported hardware profile', () => {
    expect(findRecommendedModel({ ramBytes: 3 * GB, vramBytes: null, unified: false })).toBeNull()
  })

  it('withholds GPU-recommended models when their graphics-memory requirement is unavailable', () => {
    const model = RECOMMENDED_MODELS.find((candidate) => candidate.id === 'llama-3.3-70b-q4')!

    expect(
      isModelHardwareCompatible(model, { ramBytes: 128 * GB, vramBytes: null, unified: false })
    ).toBe(false)
    expect(
      isModelHardwareCompatible(model, { ramBytes: 128 * GB, vramBytes: 48 * GB, unified: false })
    ).toBe(true)
  })
})
