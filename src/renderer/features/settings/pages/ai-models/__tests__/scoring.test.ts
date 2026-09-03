import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '@shared/system.types'
import type { ModelInfo } from '@shared/model.types'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import { contextSizeFor } from '@shared/modelRecommendation'
import type { RecommendedModel } from '@shared/recommendedModels'
import { RECOMMENDED_MODELS, recommendedModelFileName } from '@shared/recommendedModels'
import {
  ctxSizeWarning,
  buildRecommendedSlots,
  bytesToGb,
  mergeCatalogs,
  reliabilityScoreForRecommended
} from '../scoring'

const GB = 1024 ** 3

function hardware(overrides: Partial<HardwareInfo>): HardwareInfo {
  return {
    cpu: 'Test CPU',
    cores: 8,
    ram: '16 GB',
    ramBytes: 16 * GB,
    os: 'Test OS',
    gpu: null,
    gpuDriver: null,
    vram: null,
    vramBytes: null,
    unifiedMemory: false,
    storageFree: null,
    ...overrides
  }
}

function installedFor(modelId: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  const model = RECOMMENDED_MODELS.find((m) => m.id === modelId)
  if (!model) throw new Error(`No catalog model ${modelId}`)
  return {
    id: `installed-${modelId}`,
    name: model.name,
    path: `/models/${recommendedModelFileName(model)}`,
    sizeBytes: 1,
    source: 'local',
    ...overrides
  }
}

function hfModel(overrides: Partial<import('@shared/recommendedModels').RecommendedModel> = {}) {
  return {
    id: 'hf:some/repo:some-model-q4_k_m.gguf',
    name: 'Some Model (Q4_K_M)',
    family: 'other' as const,
    tier: '7b' as const,
    description: 'Community GGUF from Hugging Face.',
    approxSize: '4.0 GB',
    minRam: '15 GB',
    minRamGb: 15,
    idealRamGb: 20,
    downloadUrl: 'https://huggingface.co/some/repo/resolve/main/some-model-q4_k_m.gguf',
    tags: ['community'],
    primaryUse: 'general' as const,
    supportsTools: false,
    source: 'huggingface' as const,
    repoId: 'some/repo',
    hfDownloads: 1000,
    ...overrides
  }
}

function reliabilityRecord(score: number, modelId: string): ModelReliabilityRecord {
  // successRate === score, no fabrications, well above the min-attempts floor.
  const successes = score
  const errors = 100 - score
  return {
    modelId,
    modelName: modelId,
    byTool: { edit_file: { successes, errors } },
    fabrications: 0,
    lastUsedAt: Date.now()
  }
}

describe('ctxSizeWarning', () => {
  describe('dedicated GPU (VRAM holds the KV cache)', () => {
    it('warns when 16k context is requested on under 8 GB VRAM', () => {
      expect(ctxSizeWarning(hardware({ vramBytes: 6 * GB }), 16384)).toBe(true)
    })

    it('does not warn when 16k context is requested with 8 GB+ VRAM', () => {
      expect(ctxSizeWarning(hardware({ vramBytes: 8 * GB }), 16384)).toBe(false)
    })

    it('warns when 32k context is requested on under 12 GB VRAM', () => {
      expect(ctxSizeWarning(hardware({ vramBytes: 10 * GB }), 32768)).toBe(true)
    })

    it('warns when 64k context is requested on under 16 GB VRAM', () => {
      expect(ctxSizeWarning(hardware({ vramBytes: 14 * GB }), 65536)).toBe(true)
    })

    it('warns when 128k context is requested on under 24 GB VRAM', () => {
      expect(ctxSizeWarning(hardware({ vramBytes: 20 * GB }), 131072)).toBe(true)
    })

    it('warns when 256k context is requested on under 32 GB VRAM', () => {
      expect(ctxSizeWarning(hardware({ vramBytes: 24 * GB }), 262144)).toBe(true)
    })

    it('does not warn when VRAM comfortably covers the largest context', () => {
      expect(ctxSizeWarning(hardware({ vramBytes: 48 * GB }), 262144)).toBe(false)
    })
  })

  describe('CPU-only (no VRAM at all)', () => {
    it('warns on a small-RAM machine requesting 16k context', () => {
      expect(ctxSizeWarning(hardware({ ramBytes: 6 * GB, vramBytes: null }), 16384)).toBe(true)
    })

    it('does not silently skip the warning just because there is no dedicated GPU', () => {
      // This was the original bug: `ctxSizeWarning` returned false unconditionally
      // whenever `vramBytes` was falsy, so CPU-only machines never got a warning
      // no matter how large a context they picked relative to their RAM.
      expect(ctxSizeWarning(hardware({ ramBytes: 8 * GB, vramBytes: null }), 131072)).toBe(true)
    })

    it('does not warn when RAM comfortably covers the requested context', () => {
      expect(ctxSizeWarning(hardware({ ramBytes: 32 * GB, vramBytes: null }), 16384)).toBe(false)
    })

    it('warns when 256k context is requested on under 96 GB RAM', () => {
      expect(ctxSizeWarning(hardware({ ramBytes: 64 * GB, vramBytes: null }), 262144)).toBe(true)
    })

    it('does not warn on a huge-RAM workstation requesting the largest context', () => {
      expect(ctxSizeWarning(hardware({ ramBytes: 128 * GB, vramBytes: null }), 262144)).toBe(false)
    })
  })

  describe('unified memory (Apple Silicon): RAM-based even when vramBytes is reported', () => {
    it('warns using the RAM thresholds, not the (more lenient) VRAM thresholds', () => {
      // At 32k context the two threshold sets actually differ: the dedicated-
      // GPU path only warns under 12 GB VRAM, but the RAM path warns under
      // 16 GB. 14 GB sits in between, so this only warns if unified memory
      // correctly takes the RAM path instead of the VRAM one.
      const result = ctxSizeWarning(
        hardware({ ramBytes: 14 * GB, vramBytes: 14 * GB, unifiedMemory: true }),
        32768
      )
      expect(result).toBe(true)
    })

    it('does not warn once unified memory is large enough', () => {
      const result = ctxSizeWarning(
        hardware({ ramBytes: 64 * GB, vramBytes: 64 * GB, unifiedMemory: true }),
        32768
      )
      expect(result).toBe(false)
    })
  })
})

describe('buildRecommendedSlots — Large Context', () => {
  it('never recommends a model that cannot fit on this hardware, even if it needs the most RAM in the catalog', () => {
    // 63 GB is below the 70B model's 96 GB minimum. Sorting by raw minRamGb
    // (the original bug) would still pick it here, since it's the largest
    // minRamGb in the whole catalog — regardless of whether it can load at all.
    const slots = buildRecommendedSlots(hardware({ ramBytes: 63 * GB, unifiedMemory: true }), null)
    const largeContext = slots.find((slot) => slot.id === 'large-context')
    expect(largeContext?.model.id).not.toBe('llama-3.3-70b-q4')
  })

  it('picks a model that actually fits, among those tied on achievable context size', () => {
    const slots = buildRecommendedSlots(hardware({ ramBytes: 63 * GB, unifiedMemory: true }), null)
    const largeContext = slots.find((slot) => slot.id === 'large-context')
    expect(largeContext?.model.minRamGb).toBeLessThanOrEqual(63)
  })

  it('can recommend the 70B model once RAM genuinely supports it', () => {
    const slots = buildRecommendedSlots(hardware({ ramBytes: 128 * GB, unifiedMemory: true }), null)
    const largeContext = slots.find((slot) => slot.id === 'large-context')
    expect(largeContext?.model.minRamGb).toBeLessThanOrEqual(128)
  })

  it('always lands on a model genuinely tied for the best achievable context, even after an earlier slot claims the naive top pick', () => {
    // Regression test for the original bug: "Best Overall" and "Large Context"
    // both naturally rank Qwen 32B first on this hardware (it also wins the
    // score tie-break among every model tied for max context), so this
    // exercises the exact dedup-fallback path that used to abandon the
    // context criterion entirely once 32B was already claimed.
    const hw = hardware({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB, gpu: 'Test GPU' })
    const slots = buildRecommendedSlots(hw, null)
    const largeContext = slots.find((slot) => slot.id === 'large-context')
    expect(largeContext).toBeDefined()
    expect(largeContext?.model.id).not.toBe('qwen2.5-coder-32b-q4') // claimed by Best Overall

    const ramGb = bytesToGb(hw.ramBytes)
    const vramGb = bytesToGb(hw.vramBytes ?? 0)
    const eligible = RECOMMENDED_MODELS.filter(
      (model) => model.recommended !== false && ramGb >= model.minRamGb
    )
    const bestPossibleContext = Math.max(
      ...eligible.map((model) => contextSizeFor(model, ramGb, vramGb))
    )
    expect(contextSizeFor(largeContext!.model, ramGb, vramGb)).toBe(bestPossibleContext)
  })
})

describe('buildRecommendedSlots — Best Coding', () => {
  it('falls back to the next coding-tagged model, not just any next-best model, once the top pick is claimed elsewhere', () => {
    // Same hardware/regression shape as the Large Context test above: Qwen 32B
    // is both "Best Overall" and the top coding-tagged pick, so this exercises
    // whether "Best Coding" correctly moves to its own second-best coding
    // candidate instead of falling through to an unrelated model.
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB, gpu: 'Test GPU' }),
      null
    )
    const bestCoding = slots.find((slot) => slot.id === 'coding')
    expect(bestCoding).toBeDefined()
    expect(bestCoding?.model.id).not.toBe('qwen2.5-coder-32b-q4')
    expect(
      bestCoding?.model.tags.includes('coding') || bestCoding?.model.primaryUse === 'coding'
    ).toBe(true)
  })

  it('never recommends a model below its own RAM minimum, even as a fallback', () => {
    // On an 8 GB machine the only catalog model tagged for coding that fits
    // is Qwen 3B Coder, which "Best Overall" already claims — the slot should
    // disappear rather than fall back to a 7B model needing 16 GB.
    const slots = buildRecommendedSlots(hardware({ ramBytes: 8 * GB }), null)
    for (const slot of slots) {
      expect(slot.model.minRamGb).toBeLessThanOrEqual(8)
    }
    expect(slots.find((slot) => slot.id === 'coding')).toBeUndefined()
  })
})

describe('buildRecommendedSlots — Best Agent', () => {
  it('only ever recommends a tool-calling-capable model', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB, gpu: 'Test GPU' }),
      null
    )
    const bestAgent = slots.find((slot) => slot.id === 'agent')
    expect(bestAgent).toBeDefined()
    expect(bestAgent?.model.supportsTools).toBe(true)
  })

  it('disappears rather than recommend a non-tool-calling model, once every tool-capable candidate is claimed', () => {
    // On an 8 GB machine the only eligible, tool-calling-capable catalog
    // model is Qwen 3B Coder — "Best Overall" claims it first, so there is
    // nothing left for "Best Agent" to fall back to.
    const slots = buildRecommendedSlots(hardware({ ramBytes: 8 * GB }), null)
    expect(slots.find((slot) => slot.id === 'agent')).toBeUndefined()
  })

  it('prefers real observed reliability over the static catalog score when both candidates are tool-capable', () => {
    // On this hardware (64 GB RAM, 16 GB VRAM, a GPU), Best Overall claims
    // 32B and Best Coding claims Codestral (both non-tool-calling contenders
    // beat 14B on the plain catalog score), leaving 14B as Best Agent's
    // static top pick over 7B. A strong real reliability record for 7B and a
    // poor one for 14B should be enough to flip that ranking, even though 7B
    // still trails 14B on the static catalog score alone.
    const hw = hardware({ ramBytes: 64 * GB, vramBytes: 16 * GB, gpu: 'Test GPU' })
    const installedModels = [installedFor('qwen2.5-coder-14b-q4'), installedFor('qwen3-8b-q4')]

    const withoutReliability = buildRecommendedSlots(hw, null, {
      installedModels,
      reliability: new Map()
    })
    expect(withoutReliability.find((slot) => slot.id === 'agent')?.model.id).toBe(
      'qwen2.5-coder-14b-q4'
    )

    const reliability = new Map([
      ['installed-qwen2.5-coder-14b-q4', reliabilityRecord(20, 'installed-qwen2.5-coder-14b-q4')],
      ['installed-qwen3-8b-q4', reliabilityRecord(95, 'installed-qwen3-8b-q4')]
    ])
    const withReliability = buildRecommendedSlots(hw, null, { installedModels, reliability })
    expect(withReliability.find((slot) => slot.id === 'agent')?.model.id).toBe('qwen3-8b-q4')
  })
})

describe('reliabilityScoreForRecommended', () => {
  it('returns null for a model that was never downloaded', () => {
    const model = RECOMMENDED_MODELS.find((m) => m.id === 'qwen2.5-coder-14b-q4')!
    expect(reliabilityScoreForRecommended(model, [], new Map())).toBeNull()
  })

  it('returns null for a downloaded model with no reliability record yet', () => {
    const model = RECOMMENDED_MODELS.find((m) => m.id === 'qwen2.5-coder-14b-q4')!
    const installed = installedFor('qwen2.5-coder-14b-q4')
    expect(reliabilityScoreForRecommended(model, [installed], new Map())).toBeNull()
  })

  it('matches a downloaded model to its reliability record by filename', () => {
    const model = RECOMMENDED_MODELS.find((m) => m.id === 'qwen2.5-coder-14b-q4')!
    const installed = installedFor('qwen2.5-coder-14b-q4')
    const reliability = new Map([[installed.id, reliabilityRecord(85, installed.id)]])
    expect(reliabilityScoreForRecommended(model, [installed], reliability)).toBe(85)
  })
})

describe('buildRecommendedSlots — slot set', () => {
  it('shows no automatic recommendation when every model exceeds the machine profile', () => {
    expect(buildRecommendedSlots(hardware({ ramBytes: 3 * GB }), null)).toEqual([])
  })

  it('no longer includes a Low RAM slot', () => {
    const slots = buildRecommendedSlots(hardware({ ramBytes: 32 * GB }), null)
    expect(slots.find((slot) => slot.id === 'low-ram')).toBeUndefined()
  })

  it('never recommends the same model for two different slots', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB, gpu: 'Test GPU' }),
      null
    )
    const ids = slots.map((slot) => slot.model.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses distinct model families when a slot has a compatible alternative', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 64 * GB, vramBytes: 16 * GB, gpu: 'Test GPU' }),
      null
    )
    const families = slots.map((slot) => slot.model.family)
    const repeated = families.filter((family, index) => families.indexOf(family) !== index)

    // Qwen is allowed to repeat when it is the only catalog family with
    // verified local tool support. Every other family should appear once.
    expect(repeated.every((family) => family === 'qwen')).toBe(true)
  })

  it('does not call a tiny model the fastest option on a powerful computer', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 64 * GB, vramBytes: 16 * GB, gpu: 'Test GPU' }),
      null
    )
    const fastest = slots.find((slot) => slot.id === 'fastest')

    expect(fastest).toBeDefined()
    expect(['14b', '32b', '70b']).toContain(fastest?.model.tier)
  })
})

describe('mergeCatalogs', () => {
  it('includes a live model that does not collide with any static entry', () => {
    const live = hfModel()
    const merged = mergeCatalogs(RECOMMENDED_MODELS, [live])
    expect(merged).toHaveLength(RECOMMENDED_MODELS.length + 1)
    expect(merged).toContain(live)
  })

  it('drops a live model that is the exact same downloadable file as a static entry, keeping the static one', () => {
    const staticEntry = RECOMMENDED_MODELS.find((m) => m.id === 'qwen2.5-coder-14b-q4')!
    const duplicateLive = hfModel({
      id: 'hf:Qwen/Qwen2.5-Coder-14B-Instruct-GGUF:qwen2.5-coder-14b-instruct-q4_k_m.gguf',
      downloadUrl: staticEntry.downloadUrl
    })
    const merged = mergeCatalogs(RECOMMENDED_MODELS, [duplicateLive])
    expect(merged).toHaveLength(RECOMMENDED_MODELS.length)
    expect(merged).not.toContain(duplicateLive)
    expect(merged).toContain(staticEntry)
  })
})

describe('buildRecommendedSlots — custom catalog (live Hugging Face pool)', () => {
  it('can recommend a live-only model when it is the best fit and no static model beats it', () => {
    // A live model with a much higher qualityRank-equivalent standing (via a
    // strong reliability record) than anything in the static catalog on very
    // constrained hardware should still be able to win a slot — proving the
    // strip is not silently locked to the static list once a catalog is passed in.
    const constrained = hfModel({ id: 'hf:tiny/repo:tiny-q4_k_m.gguf', minRamGb: 4, tier: '1b' })
    const slots = buildRecommendedSlots(hardware({ ramBytes: 4 * GB }), null, undefined, [
      constrained
    ])
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((slot) => slot.model.id === constrained.id)).toBe(true)
  })

  it('defaults to the static catalog alone when no catalog is passed', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB }),
      null
    )
    for (const slot of slots) {
      expect(slot.model.source).not.toBe('huggingface')
    }
  })
})

/**
 * Live Hugging Face results are the recommendation; the built-in catalog is the
 * fallback for when they cannot be fetched.
 *
 * They used to compete, and the built-in list won twice over: `bestOverall`
 * pinned whatever `recommendModel` chose, and that reads the hardcoded catalog
 * alone. A machine that could comfortably run current models was being told to
 * download a generation-old one.
 */
describe('buildRecommendedSlots - live results outrank the built-in catalog', () => {
  const big = hardware({ ramBytes: 64 * GB, vramBytes: 24 * GB, gpu: 'Test GPU' })

  function liveModel(overrides: Partial<RecommendedModel> = {}): RecommendedModel {
    return {
      id: 'hf:Qwen/Qwen3-32B-GGUF:q4.gguf',
      name: 'Qwen3 32B',
      family: 'qwen',
      tier: '32b',
      description: 'Community GGUF from Hugging Face.',
      approxSize: '19.0 GB',
      minRam: '32 GB',
      minRamGb: 32,
      idealRamGb: 48,
      downloadUrl: 'https://example.invalid/q.gguf',
      tags: ['coding', 'community'],
      primaryUse: 'coding',
      supportsTools: true,
      source: 'huggingface',
      ...overrides
    }
  }

  it('shows only live models when any of them fit', () => {
    const slots = buildRecommendedSlots(big, null, undefined, [...RECOMMENDED_MODELS, liveModel()])

    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      expect(slot.model.source).toBe('huggingface')
    }
  })

  /**
   * The exact reported symptom: a hardware recommendation naming a built-in
   * model must not pin the top card when current models are available.
   */
  it('does not let the hardware recommendation pin a built-in over a live model', () => {
    const builtIn = RECOMMENDED_MODELS.find((model) => model.minRamGb <= 64)
    if (!builtIn) throw new Error('expected a built-in model that fits')

    const slots = buildRecommendedSlots(
      big,
      {
        tier: builtIn.tier,
        modelId: builtIn.id,
        modelName: builtIn.name,
        contextSize: 8192,
        gpuLayers: 'auto',
        rationale: 'test'
      },
      undefined,
      [...RECOMMENDED_MODELS, liveModel()]
    )

    const overall = slots.find((slot) => slot.id === 'overall')
    expect(overall?.model.id).not.toBe(builtIn.id)
    expect(overall?.model.source).toBe('huggingface')
  })

  it('falls back to the built-in catalog when nothing live is available', () => {
    const slots = buildRecommendedSlots(big, null, undefined, RECOMMENDED_MODELS)

    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((slot) => slot.model.source !== 'huggingface')).toBe(true)
  })

  /** A live model too large for the machine must not empty the strip. */
  it('falls back when live results exist but none fit this computer', () => {
    const small = hardware({ ramBytes: 8 * GB })
    const slots = buildRecommendedSlots(small, null, undefined, [
      ...RECOMMENDED_MODELS,
      liveModel({ minRamGb: 128, idealRamGb: 128 })
    ])

    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((slot) => slot.model.source !== 'huggingface')).toBe(true)
  })
})
