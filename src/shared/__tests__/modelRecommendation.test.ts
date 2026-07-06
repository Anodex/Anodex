import { describe, expect, it } from 'vitest'
import { recommendModel } from '../modelRecommendation'
import { RECOMMENDED_MODELS } from '../recommendedModels'

const GB = 1024 ** 3

function recommendedModelMinRam(modelId: string): number {
  return RECOMMENDED_MODELS.find((model) => model.id === modelId)!.minRamGb
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
    expect(rec.maxTokens).toBe(1024)
  })

  it('recommends a 7B coding model on 16 GB RAM', () => {
    const rec = recommendModel({ ramBytes: 16 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('7b')
    expect(rec.modelId).toBe('qwen2.5-coder-7b-q4')
    expect(rec.contextSize).toBe(8192)
    expect(rec.maxTokens).toBe(2048)
  })

  it('grows the context on higher-memory 7B machines', () => {
    const rec = recommendModel({ ramBytes: 24 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('7b')
    expect(rec.contextSize).toBe(16384)
  })

  it('recommends a 14B coding model on 32 GB RAM', () => {
    const rec = recommendModel({ ramBytes: 32 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('14b')
    expect(rec.modelId).toBe('qwen2.5-coder-14b-q4')
    expect(rec.contextSize).toBe(16384)
  })

  it('does not recommend 32B below the catalog RAM minimum', () => {
    const rec = recommendModel({ ramBytes: 43 * GB, vramBytes: null, unified: false })
    expect(rec.tier).toBe('14b')
    expect(rec.modelId).toBe('qwen2.5-coder-14b-q4')
  })

  it("prefers 14B over 32B at exactly 32B's RAM minimum with no GPU", () => {
    // 48 GB is only the bare minimum for 32B (zero headroom), but it's 14B's
    // own "ideal" RAM point. Without a GPU to make 32B's slower CPU-only
    // inference worthwhile, 14B is the more comfortable, reliable pick —
    // meeting a model's stated minimum isn't the same as it being the best
    // choice once a smaller model is more comfortably suited to the machine.
    const rec = recommendModel({ ramBytes: 48 * GB, vramBytes: null, unified: false })
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
    // A real reported case: 63.1 GB RAM alone isn't enough headroom to reach
    // 32B's ideal point or the next context tier — but a 55.8 GB dedicated
    // GPU sitting right there was being ignored entirely for context sizing,
    // even though it can easily host a much bigger KV cache. (It also helps
    // win the 32B tier via the existing `minVramGb` bonus — expected, and
    // covered by the "workstation" tests above; the new behavior is the
    // context size actually growing too, not just staying at 16,384.)
    const ramOnly = recommendModel({ ramBytes: 63.1 * GB, vramBytes: null, unified: false })
    expect(ramOnly.tier).toBe('14b')
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
})
