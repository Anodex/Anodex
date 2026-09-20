import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '@shared/system.types'
import type { ModelInfo } from '@shared/model.types'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import { contextSizeFor } from '@shared/modelRecommendation'
import type { RecommendedModel } from '@shared/recommendedModels'
import { recommendedModelFileName } from '@shared/recommendedModels'
import { CATALOG_FIXTURE } from '@shared/__tests__/fixtures/catalog'
import {
  ctxSizeWarning,
  buildRecommendedSlots,
  bytesToGb,
  freshnessAdjustment,
  reliabilityScoreForRecommended,
  scoreRecommendedModel
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
  const model = CATALOG_FIXTURE.find((m) => m.id === modelId)
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
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 63 * GB, unifiedMemory: true }),
      undefined,
      CATALOG_FIXTURE
    )
    const largeContext = slots.find((slot) => slot.id === 'large-context')
    expect(largeContext?.model.id).not.toBe('llama-3.3-70b-q4')
  })

  it('picks a model that actually fits, among those tied on achievable context size', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 63 * GB, unifiedMemory: true }),
      undefined,
      CATALOG_FIXTURE
    )
    const largeContext = slots.find((slot) => slot.id === 'large-context')
    expect(largeContext?.model.minRamGb).toBeLessThanOrEqual(63)
  })

  it('can recommend the 70B model once RAM genuinely supports it', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 128 * GB, unifiedMemory: true }),
      undefined,
      CATALOG_FIXTURE
    )
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
    const slots = buildRecommendedSlots(hw, undefined, CATALOG_FIXTURE)
    const largeContext = slots.find((slot) => slot.id === 'large-context')
    expect(largeContext).toBeDefined()
    expect(largeContext?.model.id).not.toBe('qwen2.5-coder-32b-q4') // claimed by Best Overall

    const ramGb = bytesToGb(hw.ramBytes)
    const vramGb = bytesToGb(hw.vramBytes ?? 0)
    const eligible = CATALOG_FIXTURE.filter(
      (model) => model.recommended !== false && ramGb >= model.minRamGb
    )
    const bestPossibleContext = Math.max(
      ...eligible.map((model) => contextSizeFor(model.tier, ramGb, vramGb))
    )
    expect(contextSizeFor(largeContext!.model.tier, ramGb, vramGb)).toBe(bestPossibleContext)
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
      undefined,
      CATALOG_FIXTURE
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
    const slots = buildRecommendedSlots(hardware({ ramBytes: 8 * GB }), undefined, CATALOG_FIXTURE)
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
      undefined,
      CATALOG_FIXTURE
    )
    const bestAgent = slots.find((slot) => slot.id === 'agent')
    expect(bestAgent).toBeDefined()
    expect(bestAgent?.model.supportsTools).toBe(true)
  })

  it('disappears rather than recommend a non-tool-calling model, once every tool-capable candidate is claimed', () => {
    // On an 8 GB machine the only eligible, tool-calling-capable catalog
    // model is Qwen 3B Coder — "Best Overall" claims it first, so there is
    // nothing left for "Best Agent" to fall back to.
    const slots = buildRecommendedSlots(hardware({ ramBytes: 8 * GB }), undefined, CATALOG_FIXTURE)
    expect(slots.find((slot) => slot.id === 'agent')).toBeUndefined()
  })

  it('prefers real observed reliability over the static catalog score when both candidates are tool-capable', () => {
    // Dated a fortnight after Qwen3 8B was published, so the two candidates are
    // the same age and neither wins on freshness — what is being tested here is
    // reliability against catalog score, and nothing else.
    const justAfterQwen3 = Date.parse('2025-05-17T00:00:00Z')
    // On this hardware (64 GB RAM, 16 GB VRAM, a GPU), Best Overall claims
    // 32B and Best Coding claims Codestral (both non-tool-calling contenders
    // beat 14B on the plain catalog score), leaving 14B as Best Agent's
    // static top pick over 7B. A strong real reliability record for 7B and a
    // poor one for 14B should be enough to flip that ranking, even though 7B
    // still trails 14B on the static catalog score alone.
    const hw = hardware({ ramBytes: 64 * GB, vramBytes: 16 * GB, gpu: 'Test GPU' })
    const installedModels = [installedFor('qwen2.5-coder-14b-q4'), installedFor('qwen3-8b-q4')]

    const withoutReliability = buildRecommendedSlots(
      hw,
      { installedModels, reliability: new Map() },
      CATALOG_FIXTURE,
      justAfterQwen3
    )
    expect(withoutReliability.find((slot) => slot.id === 'agent')?.model.id).toBe(
      'qwen2.5-coder-14b-q4'
    )

    const reliability = new Map([
      ['installed-qwen2.5-coder-14b-q4', reliabilityRecord(20, 'installed-qwen2.5-coder-14b-q4')],
      ['installed-qwen3-8b-q4', reliabilityRecord(95, 'installed-qwen3-8b-q4')]
    ])
    const withReliability = buildRecommendedSlots(
      hw,
      { installedModels, reliability },
      CATALOG_FIXTURE,
      justAfterQwen3
    )
    expect(withReliability.find((slot) => slot.id === 'agent')?.model.id).toBe('qwen3-8b-q4')
  })
})

describe('reliabilityScoreForRecommended', () => {
  it('returns null for a model that was never downloaded', () => {
    const model = CATALOG_FIXTURE.find((m) => m.id === 'qwen2.5-coder-14b-q4')!
    expect(reliabilityScoreForRecommended(model, [], new Map())).toBeNull()
  })

  it('returns null for a downloaded model with no reliability record yet', () => {
    const model = CATALOG_FIXTURE.find((m) => m.id === 'qwen2.5-coder-14b-q4')!
    const installed = installedFor('qwen2.5-coder-14b-q4')
    expect(reliabilityScoreForRecommended(model, [installed], new Map())).toBeNull()
  })

  it('matches a downloaded model to its reliability record by filename', () => {
    const model = CATALOG_FIXTURE.find((m) => m.id === 'qwen2.5-coder-14b-q4')!
    const installed = installedFor('qwen2.5-coder-14b-q4')
    const reliability = new Map([[installed.id, reliabilityRecord(85, installed.id)]])
    expect(reliabilityScoreForRecommended(model, [installed], reliability)).toBe(85)
  })
})

describe('buildRecommendedSlots — slot set', () => {
  it('shows no automatic recommendation when every model exceeds the machine profile', () => {
    expect(
      buildRecommendedSlots(hardware({ ramBytes: 3 * GB }), undefined, CATALOG_FIXTURE)
    ).toEqual([])
  })

  it('no longer includes a Low RAM slot', () => {
    const slots = buildRecommendedSlots(hardware({ ramBytes: 32 * GB }), undefined, CATALOG_FIXTURE)
    expect(slots.find((slot) => slot.id === 'low-ram')).toBeUndefined()
  })

  it('never recommends the same model for two different slots', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB, gpu: 'Test GPU' }),
      undefined,
      CATALOG_FIXTURE
    )
    const ids = slots.map((slot) => slot.model.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses distinct model families when a slot has a compatible alternative', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 64 * GB, vramBytes: 16 * GB, gpu: 'Test GPU' }),
      undefined,
      CATALOG_FIXTURE
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
      undefined,
      CATALOG_FIXTURE
    )
    const fastest = slots.find((slot) => slot.id === 'fastest')

    expect(fastest).toBeDefined()
    expect(['14b', '32b', '70b']).toContain(fastest?.model.tier)
  })
})

describe('buildRecommendedSlots — custom catalog (live Hugging Face pool)', () => {
  it('can recommend a live-only model when it is the best fit and no static model beats it', () => {
    // A live model with a much higher qualityRank-equivalent standing (via a
    // strong reliability record) than anything in the static catalog on very
    // constrained hardware should still be able to win a slot — proving the
    // strip is not silently locked to the static list once a catalog is passed in.
    const constrained = hfModel({ id: 'hf:tiny/repo:tiny-q4_k_m.gguf', minRamGb: 4, tier: '1b' })
    const slots = buildRecommendedSlots(hardware({ ramBytes: 4 * GB }), undefined, [constrained])
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((slot) => slot.model.id === constrained.id)).toBe(true)
  })

  it('defaults to the static catalog alone when no catalog is passed', () => {
    const slots = buildRecommendedSlots(
      hardware({ ramBytes: 63.1 * GB, vramBytes: 55.8 * GB }),
      undefined,
      CATALOG_FIXTURE
    )
    for (const slot of slots) {
      expect(slot.model.source).not.toBe('huggingface')
    }
  })
})

/**
 * The "live results outrank the built-in catalog" cases that used to sit here
 * are gone with the catalog itself. They pinned a real bug — the hardware
 * recommendation named a built-in model and that pin beat every current one —
 * which is now structurally impossible: there is one pool, it is the live one,
 * and `recommendModel` names a size class rather than a model. See
 * `shared/recommendedModels.ts`.
 */
describe('how much a model’s age is worth', () => {
  const now = Date.parse('2026-09-16T00:00:00Z')
  const monthsAgo = (months: number): string =>
    new Date(now - months * 30 * 86_400_000).toISOString()

  it('is worth something new, and counts against something old', () => {
    expect(freshnessAdjustment({ publishedAt: monthsAgo(1) } as RecommendedModel, now)).toBe(8)
    expect(freshnessAdjustment({ publishedAt: monthsAgo(10) } as RecommendedModel, now)).toBe(3)
    expect(freshnessAdjustment({ publishedAt: monthsAgo(15) } as RecommendedModel, now)).toBe(-8)
    expect(freshnessAdjustment({ publishedAt: monthsAgo(21) } as RecommendedModel, now)).toBe(-14)
    expect(freshnessAdjustment({ publishedAt: monthsAgo(30) } as RecommendedModel, now)).toBe(-20)
  })

  it('still lets being new count for less than being good', () => {
    // The reward side is deliberately unchanged: a brand-new model of unknown
    // worth gains +8, which a hand-rated entry can out-earn on quality alone.
    // Only the penalty for being a generation behind got heavier.
    expect(freshnessAdjustment({ publishedAt: monthsAgo(0) } as RecommendedModel, now)).toBe(8)
  })

  it('leaves a model with no date, or a date it cannot read, exactly where it was', () => {
    expect(freshnessAdjustment({} as RecommendedModel, now)).toBe(0)
    expect(freshnessAdjustment({ publishedAt: 'sometime' } as RecommendedModel, now)).toBe(0)
  })

  it('offers this month’s model over one Anodex shipped knowing about two years ago', () => {
    // The complaint this was built for: a first run on a capable machine offered a
    // model from the generation before last, because the built-in list was written
    // before the current one existed and nothing in the score knew the date.
    const now2026 = Date.parse('2026-09-16T00:00:00Z')
    const hw = hardware({ ramBytes: 64 * GB, vramBytes: 24 * GB, gpu: 'Test GPU' })
    const current: RecommendedModel = {
      ...CATALOG_FIXTURE.find((model) => model.id === 'qwen2.5-coder-32b-q4')!,
      id: 'hf:current-32b',
      name: 'Current 32B',
      publishedAt: new Date(now2026 - 30 * 86_400_000).toISOString(),
      qualityRank: undefined,
      source: 'huggingface',
      downloadUrl: 'https://huggingface.co/x/Current-32B-GGUF/resolve/main/current-32b-q4_k_m.gguf',
      hfDownloads: 9_000_000
    }

    const best = buildRecommendedSlots(hw, undefined, [...CATALOG_FIXTURE, current], now2026).find(
      (slot) => slot.id === 'overall'
    )

    expect(best?.model.id).toBe('hf:current-32b')
  })

  /**
   * Both entries here are live Hugging Face results, and both are real: these
   * are the two the strip actually chose between on the reporting machine, with
   * their real ages and download counts.
   *
   * The older one won, and its whole margin was a duplicated inference —
   * `toRecommendedModel` derives `tags` from `primaryUse`, so "Coder" in a
   * repository name was paid for twice, +12, which is more than a year of age
   * is worth on the other side of the score.
   */
  it('does not hand "best overall" to last year’s coder over this year’s flagship', () => {
    const now2026 = Date.parse('2026-09-20T00:00:00Z')
    const hw = hardware({ ramBytes: 64 * GB, vramBytes: 24 * GB, gpu: 'Radeon RX 7900 XTX' })
    const base = CATALOG_FIXTURE.find((model) => model.id === 'qwen2.5-coder-32b-q4')!
    const liveEntry = (
      id: string,
      name: string,
      ageDays: number,
      downloads: number,
      coding: boolean
    ): RecommendedModel => ({
      ...base,
      id,
      name,
      publishedAt: new Date(now2026 - ageDays * 86_400_000).toISOString(),
      qualityRank: undefined,
      speedRank: undefined,
      source: 'huggingface',
      primaryUse: coding ? 'coding' : 'general',
      tags: coding ? ['coding'] : ['general'],
      downloadUrl: `https://huggingface.co/x/${id}/resolve/main/${id}.gguf`,
      hfDownloads: downloads
    })

    const lastYearsCoder = liveEntry('coder-30b', 'Coder 30B', 416, 12_697_785, true)
    const thisYearsFlagship = liveEntry('flagship-27b', 'Flagship 27B', 38, 6_941_478, false)

    expect(scoreRecommendedModel(thisYearsFlagship, hw, now2026)).toBeGreaterThan(
      scoreRecommendedModel(lastYearsCoder, hw, now2026)
    )
  })
})
