import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '@shared/system.types'
import type { RecommendedModel } from '@shared/recommendedModels'
import { pickTier } from '@shared/modelRecommendation'
import { gpuMemoryGb } from '@shared/modelMemory'
import {
  buildRecommendedSlots,
  fastMemoryGb,
  hardwareFitLabel,
  scoreRecommendedModel
} from '../scoring'

const GB = 1024 ** 3

/**
 * What Anodex offers the machines it is about to be released onto.
 *
 * The recommendation engine was only ever checked against the machine it was
 * written on — a 64GB desktop with a 24GB card — and it gave sensible answers
 * there while giving nonsense answers nearly everywhere else. A 16GB laptop,
 * the most ordinary machine there is, was offered **Qwen3-0.6B** as "Best
 * Overall"; an 8GB laptop was offered that and nothing else, one card on an
 * otherwise empty page.
 *
 * Two separate causes, both invisible from the desktop it was developed on:
 *
 * 1. A live Hugging Face entry carries no `qualityRank`, and the default was
 *    a flat 3 for every model regardless of size — so nothing in the score
 *    knew a 0.6B is less capable than a 30B, while small models collected
 *    every fit bonus going.
 * 2. `usesTheMachine` measured against VRAM whenever there was any, so a 1GB
 *    integrated GPU made a sub-gigabyte model look like a perfect fit and a
 *    9B model look like it overflowed.
 *
 * These cases are the guard against picking up either again. They assert the
 * shape of a good answer — capability floors, memory ceilings, every slot
 * filled — rather than naming models, which change weekly.
 */

function hardware(ramGb: number, vramGb: number, unified = false): HardwareInfo {
  return {
    ramBytes: ramGb * GB,
    vramBytes: vramGb ? vramGb * GB : null,
    unifiedMemory: unified,
    cores: 8,
    gpu: vramGb > 0 || unified ? 'test gpu' : null
  } as HardwareInfo
}

/**
 * A stand-in for the live Hugging Face pool: no hand-set ranks, exactly like
 * the real thing. Sizes and RAM figures follow
 * `estimateRamRequirements` (size * 1.2 + 3), so the fit arithmetic here is
 * the arithmetic that runs in production.
 */
function liveModel(
  name: string,
  tier: RecommendedModel['tier'],
  sizeGb: number,
  extra: Partial<RecommendedModel> = {}
): RecommendedModel {
  return {
    id: `hf:test/${name}`,
    name,
    family: 'qwen',
    tier,
    description: name,
    approxSize: `${sizeGb} GB`,
    minRam: `${Math.ceil(sizeGb * 1.2 + 3)} GB`,
    minRamGb: Math.ceil(sizeGb * 1.2 + 3),
    idealRamGb: Math.ceil(sizeGb * 1.4 + 5),
    downloadUrl: `https://example.invalid/${name}.gguf`,
    tags: [],
    primaryUse: 'general',
    supportsTools: true,
    source: 'huggingface',
    publishedAt: '2026-06-01',
    hfDownloads: 500_000,
    recommended: true,
    ...extra
  }
}

const LIVE_POOL: RecommendedModel[] = [
  liveModel('tiny-0.6b', '1b', 0.8),
  liveModel('small-4b', '3b', 2.4),
  liveModel('mid-9b', '7b', 5.5),
  liveModel('large-27b', '14b', 15.3),
  liveModel('huge-70b', '70b', 42)
]

const PROFILES = [
  { name: 'budget laptop, 8GB, integrated GPU', hw: hardware(8, 1) },
  { name: 'mainstream laptop, 16GB, integrated GPU', hw: hardware(16, 1) },
  { name: 'gaming PC, 32GB, 8GB card', hw: hardware(32, 8) },
  { name: 'gaming PC, 32GB, 16GB card', hw: hardware(32, 16) },
  { name: 'MacBook Air, 16GB unified', hw: hardware(16, 16, true) },
  { name: 'MacBook Pro, 64GB unified', hw: hardware(64, 64, true) },
  { name: 'desktop, 64GB, 24GB card', hw: hardware(64, 24) },
  { name: 'workstation, 128GB, 48GB card', hw: hardware(128, 48) }
]

function slotsFor(
  hw: HardwareInfo,
  catalog: RecommendedModel[]
): ReturnType<typeof buildRecommendedSlots> {
  return buildRecommendedSlots(hw, undefined, catalog)
}

/** The live Hugging Face pool is the only pool there is now. */
const MERGED = LIVE_POOL

describe('recommendations across the machines this ships to', () => {
  it.each(PROFILES)('offers $name something it can actually work with', ({ hw }) => {
    const overall = slotsFor(hw, MERGED).find((slot) => slot.id === 'overall')
    expect(overall).toBeDefined()

    // The specific failure: a one-billion-parameter model as the headline
    // recommendation. Anything with the memory for more should be offered
    // more, and 8GB is already past the 3B tier's minimum.
    expect(overall?.model.tier).not.toBe('1b')
  })

  it.each(PROFILES)('never asks $name for memory it does not have', ({ hw }) => {
    const ramGb = hw.ramBytes / GB
    for (const slot of slotsFor(hw, MERGED)) {
      expect(slot.model.minRamGb).toBeLessThanOrEqual(ramGb)
    }
  })

  it.each(PROFILES)('fills more than one slot for $name', ({ hw }) => {
    // One lonely card on an otherwise empty page is what an 8GB machine used
    // to get, and it read as a broken page rather than a short list.
    expect(slotsFor(hw, MERGED).length).toBeGreaterThan(1)
  })

  it.each(PROFILES)('keeps the "Fastest" pick for $name inside fast memory', ({ hw }) => {
    const fastest = slotsFor(hw, MERGED).find((slot) => slot.id === 'fastest')
    if (!fastest) return
    const sizeGb = Number.parseFloat(fastest.model.approxSize)
    // A model that spills out of the graphics card runs partly on the CPU,
    // which makes it the slowest thing on offer rather than the fastest. A
    // 32GB PC with an 8GB card was being shown a 27B here.
    expect(sizeGb).toBeLessThanOrEqual(fastMemoryGb(hw) + 0.01)
  })

  it('ranks a live model by its size when nobody has rated it', () => {
    // The whole defect in one assertion: with a flat default rank, these came
    // out in the wrong order on every machine that could run both.
    const hw = hardware(32, 16)
    const tiny = scoreRecommendedModel(LIVE_POOL[0], hw)
    const mid = scoreRecommendedModel(LIVE_POOL[2], hw)
    const large = scoreRecommendedModel(LIVE_POOL[3], hw)
    expect(mid).toBeGreaterThan(tiny)
    expect(large).toBeGreaterThan(mid)
  })

  it('does not let a small integrated GPU shrink the machine', () => {
    // 16GB of RAM behind a 1GB iGPU is a 16GB machine, not a 1GB one:
    // llama.cpp keeps most layers in RAM either way.
    expect(fastMemoryGb(hardware(16, 1))).toBeGreaterThan(8)
    // A real card is where the model lives, so it still decides.
    expect(fastMemoryGb(hardware(32, 8))).toBe(8)
  })
})

describe('one ladder, not two', () => {
  it.each(PROFILES)('describes $name the way it recommends to it', ({ hw }) => {
    // The hardware panel used to carry its own thresholds and disagree with
    // the recommendation directly beneath it: a 63GB machine with a 24GB card
    // read "best target: 14B Q4 or 7B Q4" above a card offering a 32B.
    const label = hardwareFitLabel(hw)
    const tier = pickTier(
      hw.ramBytes / GB,
      gpuMemoryGb(hw.ramBytes / GB, (hw.vramBytes ?? 0) / GB, hw.unifiedMemory)
    )
    expect(tier).not.toBeNull()
    expect(label).toContain(tier!.toUpperCase())
  })
})
