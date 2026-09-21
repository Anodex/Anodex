import type { ModelInfo } from '@shared/model.types'
import type { HardwareInfo } from '@shared/system.types'
import type { RecommendedModel } from '@shared/recommendedModels'
import { recommendedModelFileName } from '@shared/recommendedModels'
import { contextSizeFor, isModelHardwareCompatible, pickTier } from '@shared/modelRecommendation'
import { fastMemoryGb as sharedFastMemoryGb, gpuMemoryGb } from '@shared/modelMemory'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import { computeReliabilityScore } from '@shared/modelReliability.types'

/**
 * Pure scoring/formatting helpers for the AI & Models page — no React here, so
 * these are easy to reason about (and unit-test) independently of the panels
 * that render them. Split out of `AiModelsSettings.tsx` to keep that file
 * focused on layout/composition.
 */

export interface RecommendedSlot {
  id: string
  label: string
  note: string
  model: RecommendedModel
  score: number
}

export interface InstalledModelScore {
  score: number
  fit: 'Excellent' | 'Good' | 'Fair' | 'Heavy'
  note: string
}

export function bytesToGb(bytes: number): number {
  return Math.max(0, bytes / 1024 ** 3)
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score))
}

const TIER_WEIGHT = {
  '1b': 1,
  '3b': 3,
  '7b': 7,
  '14b': 14,
  '32b': 32,
  '70b': 70
} as const

/**
 * A "Fastest" card should still be useful for the detected machine. On a
 * workstation that can comfortably run larger models, a 1B or 3B model is
 * fast but needlessly weak, so retain enough capability for the card to be a
 * practical daily driver. Small machines retain access to their fitting tier.
 *
 * The floor is measured against what fits in fast memory, not against
 * everything the machine can load. Those are different questions once RAM is
 * plentiful and the graphics card is not: a 32GB PC with an 8GB card can
 * *open* a 30B model, so the old floor promoted "Fastest" to 14B-and-up and
 * offered a 27B — which on that card runs mostly on the CPU and is the
 * slowest thing in the list. Whatever fits on the card is the honest pool;
 * if nothing does, fall back to the full set rather than showing no card.
 */
function fastestAppropriateCandidates(
  candidates: { model: RecommendedModel; score: number }[],
  hardware: HardwareInfo | null
): { model: RecommendedModel; score: number }[] {
  const fastGb = hardware ? fastMemoryGb(hardware) : 0
  const fitting =
    fastGb > 0 ? candidates.filter((candidate) => modelSizeGb(candidate.model) <= fastGb) : []
  const pool = fitting.length > 0 ? fitting : candidates
  const largestTier = Math.max(...pool.map((candidate) => TIER_WEIGHT[candidate.model.tier]))
  const minimumTier = largestTier >= 32 ? 14 : largestTier >= 14 ? 7 : largestTier >= 7 ? 3 : 1
  return pool.filter((candidate) => TIER_WEIGHT[candidate.model.tier] >= minimumTier)
}

export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/**
 * Real observed tool-calling reliability for a catalog model, if the user has
 * actually downloaded and used it — matched by filename, the same technique
 * the "Downloaded" badge already uses, since a `RecommendedModel` and its
 * on-disk `ModelInfo` don't share an id. Returns null if the model was never
 * downloaded, or was downloaded but hasn't been used enough yet to score
 * (see `MIN_ATTEMPTS_FOR_RELIABILITY_SCORE`).
 */
export function reliabilityScoreForRecommended(
  model: RecommendedModel,
  installedModels: ModelInfo[],
  reliability: Map<string, ModelReliabilityRecord>
): number | null {
  const targetName = recommendedModelFileName(model).toLowerCase()
  const installed = installedModels.find((m) => basename(m.path).toLowerCase() === targetName)
  if (!installed) return null
  return computeReliabilityScore(reliability.get(installed.id))
}

/**
 * Warn when the selected context size seems too large for the detected
 * memory. The KV cache lives in VRAM on a dedicated GPU, but draws from
 * system RAM on CPU-only and unified-memory (Apple Silicon) machines.
 */
export function ctxSizeWarning(hardware: HardwareInfo, selectedCtx: number): boolean {
  if (!hardware.unifiedMemory && hardware.vramBytes) {
    const vramGb = hardware.vramBytes / 1024 ** 3
    if (selectedCtx >= 1048576 && vramGb < 80) return true
    if (selectedCtx >= 524288 && vramGb < 48) return true
    if (selectedCtx >= 262144 && vramGb < 32) return true
    if (selectedCtx >= 131072 && vramGb < 24) return true
    if (selectedCtx >= 65536 && vramGb < 16) return true
    if (selectedCtx >= 32768 && vramGb < 12) return true
    if (selectedCtx >= 16384 && vramGb < 8) return true
    if (selectedCtx >= 8192 && vramGb < 4) return true
    return false
  }

  const ramGb = bytesToGb(hardware.ramBytes)
  if (selectedCtx >= 1048576 && ramGb < 256) return true
  if (selectedCtx >= 524288 && ramGb < 160) return true
  if (selectedCtx >= 262144 && ramGb < 96) return true
  if (selectedCtx >= 131072 && ramGb < 64) return true
  if (selectedCtx >= 65536 && ramGb < 32) return true
  if (selectedCtx >= 32768 && ramGb < 16) return true
  if (selectedCtx >= 16384 && ramGb < 8) return true
  return false
}

export function scoreHardwareProfile(hardware: HardwareInfo): number {
  const ramGb = bytesToGb(hardware.ramBytes)
  const vramGb = hardware.vramBytes ? bytesToGb(hardware.vramBytes) : 0
  const coreScore = Math.min(20, hardware.cores * 1.35)
  const ramScore = Math.min(38, ramGb * 1.15)
  const vramScore = hardware.unifiedMemory ? Math.min(28, ramGb * 0.55) : Math.min(28, vramGb * 3.5)
  const gpuBonus = hardware.gpu ? 8 : 0
  const unifiedBonus = hardware.unifiedMemory ? 4 : 0
  return clampScore(Math.round(14 + coreScore + ramScore + vramScore + gpuBonus + unifiedBonus))
}

/**
 * One line describing what this machine is good for.
 *
 * The target size comes from `pickTier`, the same ladder the recommendation
 * itself uses. It used to be a second, hand-written ladder with its own
 * thresholds, and the two disagreed: on a 63 GB machine with a 24 GB card
 * this panel read "best target: 14B Q4 or 7B Q4" — it wanted 64 GB for the
 * top rung — directly above a card recommending a 32B model. Two ladders for
 * one question is one ladder too many.
 */
export function hardwareFitLabel(hardware: HardwareInfo): string {
  const ramGb = bytesToGb(hardware.ramBytes)
  const vramGb = hardware.vramBytes ? bytesToGb(hardware.vramBytes) : 0
  const tier = pickTier(ramGb, gpuMemoryGb(ramGb, vramGb, hardware.unifiedMemory))
  if (!tier) return 'Limited local AI fit · below what a local model needs'

  const quality =
    tier === '70b' || tier === '32b'
      ? 'Excellent'
      : tier === '14b'
        ? 'Strong'
        : tier === '7b'
          ? 'Good'
          : 'Modest'
  return `${quality} local AI fit · best target: ${tier.toUpperCase()} Q4 models`
}

/**
 * Ranking score used to pick and order recommended-model slots. Deliberately
 * unclamped — clamping here (rather than only at display time) caused ties
 * between models that comfortably fit but differ meaningfully in capability
 * (e.g. a 3B and a 32B model both saturating at 100), which made "Best
 * Coding" pick whichever tied model happened to sit first in the catalog
 * array instead of the actually stronger one. Clamp only when rendering a
 * badge via `clampScore`.
 */
/**
 * What a model of this size is worth when nobody has rated it.
 *
 * A hand-curated entry carries measured `qualityRank`/`speedRank`; a live
 * Hugging Face entry carries neither, and defaulting both to a flat 3 told
 * the scorer that a 0.6B model is exactly as capable, and exactly as fast, as
 * a 30B one. Nothing else in the score knows how big a model is, so among
 * live entries capability simply did not exist — and since small models
 * always fit, always score a perfect memory ratio and never take a headroom
 * penalty, they won. Measured before this: Best Overall on a 16GB laptop was
 * `Qwen3-0.6B`.
 *
 * The numbers are the curated catalog's own median rank per tier, so a live
 * entry lands where a hand-rated model of that size already sits rather than
 * on a scale invented here. It is a prior, not a rating: a real
 * `qualityRank` always wins, because this is only consulted when there is
 * none.
 */
const TIER_PRIOR = {
  '1b': { quality: 1, speed: 5 },
  '3b': { quality: 3, speed: 5 },
  '7b': { quality: 5, speed: 4 },
  '14b': { quality: 7, speed: 3 },
  '32b': { quality: 9, speed: 2 },
  '70b': { quality: 10, speed: 1 }
} as const

export function qualityRankOf(model: RecommendedModel): number {
  return model.qualityRank ?? TIER_PRIOR[model.tier].quality
}

export function speedRankOf(model: RecommendedModel): number {
  return model.speedRank ?? TIER_PRIOR[model.tier].speed
}

export function scoreRecommendedModel(
  model: RecommendedModel,
  hardware: HardwareInfo | null,
  now: number = Date.now()
): number {
  if (!hardware) return 70 + qualityRankOf(model) * 2 + freshnessAdjustment(model, now)

  const ramGb = bytesToGb(hardware.ramBytes)
  const vramGb = hardware.vramBytes ? bytesToGb(hardware.vramBytes) : 0
  const ramHeadroom = ramGb - model.minRamGb
  const idealRatio = model.idealRamGb ? Math.min(1, ramGb / model.idealRamGb) : 1

  let score = 48
  score += qualityRankOf(model) * 4
  score += speedRankOf(model) * 2
  score += idealRatio * 12
  score += usesTheMachine(model, hardware)
  // One coding signal, counted once.
  //
  // These were two separate bonuses, and for a live Hugging Face entry they are
  // not two facts — `toRecommendedModel` sets `tags` *from* `primaryUse`, which
  // `inferPrimaryUse` reads off the repository name. So a repository with
  // "Coder" in its name collected +12 for one inference, and +12 is more than a
  // whole generation of age is worth on the other side of this function.
  //
  // Measured on this machine: `Qwen3-Coder-30B-A3B-Instruct`, 416 days old,
  // scored 128 and took "Best Overall" from `Qwen3.8-27B` at 121, which was 38
  // days old. The older model's entire margin was the duplicate.
  if (model.primaryUse === 'coding' || model.primaryUse === 'agentic-coding') score += 8
  else if (model.tags.includes('coding')) score += 4
  if (model.supportsTools) score += 5
  if (model.minVramGb && !hardware.unifiedMemory && vramGb >= model.minVramGb) score += 5
  if (model.minVramGb && !hardware.unifiedMemory && vramGb < model.minVramGb) score -= 8
  if (model.requiresGpuRecommended && !hardware.gpu && !hardware.unifiedMemory) score -= 14
  if (ramHeadroom < 0) score -= Math.abs(ramHeadroom) * 6
  // A live Hugging Face entry has no hand-verified qualityRank (it's left
  // unset, defaulting to a neutral 3 above) — without this, a genuinely
  // current, widely-used model could never outrank an older hand-picked
  // catalog entry just because nobody has manually rated it yet, defeating
  // the point of sourcing recommendations live. Real download counts are the
  // same "trust proxy" already used and disclosed in the Discover panel, so
  // this reuses that reasoning rather than inventing a new one. Log-scaled
  // and capped at roughly half of what a top qualityRank (10) contributes,
  // so popularity alone still can't beat a model this project has actually
  // hand-tested — it can only compete with other unverified entries and
  // lower-ranked static ones.
  if (model.source === 'huggingface' && model.hfDownloads) {
    score += Math.min(20, Math.log10(model.hfDownloads + 1) * 4)
  }
  score += freshnessAdjustment(model, now)

  return Math.round(score)
}

/**
 * A model's size read off its download size, in GB. Falls back to what it asks
 * of memory, which is always the larger number and never far off.
 */
function modelSizeGb(model: RecommendedModel): number {
  const stated = /([\d.]+)\s*GB/i.exec(model.approxSize)
  const size = stated ? Number.parseFloat(stated[1] ?? '') : NaN
  return Number.isFinite(size) && size > 0 ? size : model.minRamGb * 0.6
}

/**
 * How well a model uses the machine it would run on.
 *
 * "The best model for this computer" is not "a model this computer can open".
 * The score used to reward headroom — how much memory was left over — which
 * says a 1GB model on a 24GB graphics card is an excellent fit, and it was: on
 * a machine with 63GB of memory and a 24GB card, Anodex recommended a
 * two-billion-parameter model over the twenty-seven-billion one the machine
 * runs every day, because the small one left more room.
 *
 * What counts is the memory a model can actually run *fast* in: the graphics
 * card where there is one, shared memory on an Apple machine, and otherwise
 * system memory, which is slower and never all available. A model should fill
 * that and not much more — spilling past it means running partly on the CPU,
 * which works and crawls.
 */
/**
 * {@link sharedFastMemoryGb} for a detected machine.
 *
 * The rule itself lives in `shared/modelMemory` because the tier ladder needs
 * it too — the top rung is only offered to a machine that can hold it in fast
 * memory — and two copies of "where does a model actually run" is how the
 * hardware panel and the recommendation beneath it came to disagree.
 */
export function fastMemoryGb(hardware: HardwareInfo): number {
  return sharedFastMemoryGb(
    bytesToGb(hardware.ramBytes),
    hardware.vramBytes ? bytesToGb(hardware.vramBytes) : 0,
    hardware.unifiedMemory
  )
}

function usesTheMachine(model: RecommendedModel, hardware: HardwareInfo): number {
  // A graphics card only decides this when there is enough of it to hold a
  // model worth running. Below `recommendModel`'s own four-gigabyte bar the
  // card is an integrated one sharing system memory, and llama.cpp puts most
  // of the layers in RAM regardless — so measuring against its one or two
  // gigabytes made a 0.6B model look like a perfect fit for a laptop and a
  // 9B model look like it overflowed. Measured: on 16GB with a 1GB iGPU that
  // was a 19-point swing in the toy model's favour, and it won Best Overall.
  const runsFastIn = fastMemoryGb(hardware)
  if (runsFastIn <= 0) return 0

  const used = modelSizeGb(model) / runsFastIn
  let score = 24 * Math.min(1, used)
  // Leaving three quarters of the machine idle is not a recommendation, it is a
  // smaller model that happens to fit.
  if (used < 0.25) score -= 10
  if (used > 1) score -= Math.min(24, (used - 1) * 30)
  return score
}

/**
 * What a model's age is worth, in a field where a year is a generation.
 *
 * Nothing else in this score knows the date. A hand-rated entry keeps its rank
 * for ever, so the best model Anodex could offer a new user stayed the best one
 * somebody typed in — every built-in entry was between one and two and a half
 * years old when this was written, and the model this machine actually runs was
 * newer than all of them.
 *
 * Bounded, and smaller than what hand-verified quality is worth: a current model
 * should win a close call, not walk past a better one for being new. An entry
 * with no date is left alone rather than guessed at.
 */
export function freshnessAdjustment(model: RecommendedModel, now: number = Date.now()): number {
  if (!model.publishedAt) return 0
  const published = Date.parse(model.publishedAt)
  if (Number.isNaN(published)) return 0

  const months = (now - published) / (30 * 86_400_000)
  if (months <= 6) return 8
  if (months <= 12) return 3
  // Past a year is past a generation, and the penalties now say so.
  //
  // The band boundaries were right and the numbers under them were not: this
  // function opens by saying a year is a generation, then charged a
  // thirteen-month-old model −3, which is less than a rounding error against
  // the other terms here. A model a generation behind was losing a close call
  // it should not have been in.
  //
  // Only the penalty side moved. The reward for being new is still +8, so a
  // brand-new model of unknown worth still cannot walk past a better one on
  // novelty alone — which is the balance the paragraph above asks for.
  if (months <= 18) return -8
  if (months <= 24) return -14
  return -20
}

export interface AgentReliabilityContext {
  installedModels: ModelInfo[]
  reliability: Map<string, ModelReliabilityRecord>
}

export function buildRecommendedSlots(
  hardware: HardwareInfo | null,
  agentContext: AgentReliabilityContext | undefined,
  // Required, and always the live Hugging Face pool. There used to be a
  // hand-written catalog defaulted in here; it is gone, because a list of
  // models to download helps nobody who cannot reach the network to download
  // them, and every entry in it aged into a worse answer than no answer.
  catalog: RecommendedModel[],
  // Today, so a test can pin one: what Anodex recommends now depends on how old
  // each model is, and a test that reads the clock changes its mind as the
  // calendar moves under it.
  now: number = Date.now()
): RecommendedSlot[] {
  const allCandidates = catalog
  // Every card shares this strict eligibility gate. A model that misses its
  // catalog RAM or explicit GPU requirement must never appear as a safe
  // automatic choice; if nothing fits, the strip explains that rather than
  // suggesting an oversized fallback.
  const eligible = (pool: RecommendedModel[]): RecommendedModel[] =>
    hardware
      ? pool.filter((model) =>
          isModelHardwareCompatible(model, {
            ramBytes: hardware.ramBytes,
            vramBytes: hardware.vramBytes,
            unified: hardware.unifiedMemory
          })
        )
      : pool

  const candidates = eligible(allCandidates)
  if (candidates.length === 0) return []
  const scored = candidates
    .map((model) => ({ model, score: scoreRecommendedModel(model, hardware, now) }))
    .sort((a, b) => b.score - a.score)
  const byScore = scored.map((entry) => entry.model)
  const speedCandidates = fastestAppropriateCandidates(scored, hardware)

  const used = new Set<string>()
  const usedFamilies = new Set<string>()
  /**
   * Picks the first model in `rank()`'s order that no earlier slot has
   * already claimed. `rank()` must list ITS OWN best-fit candidates first and
   * fall back to `byScore` (or another total order) as a tail — that way, if
   * a slot's top pick was already claimed by an earlier slot, it moves on to
   * its own second-best match instead of abandoning its criteria entirely.
   * (The previous version fell back straight to "whatever's next by overall
   * score," so e.g. "Best Coding" could lose its top pick and fall back to a
   * non-coding model, and "Large Context" could fall back to a model that
   * doesn't actually have the largest context on this hardware.)
   */
  const take = (
    id: string,
    label: string,
    note: string,
    rank: () => RecommendedModel[]
  ): RecommendedSlot | null => {
    const unused = rank().filter((candidate) => !used.has(candidate.id))
    const model = unused.find((candidate) => !usedFamilies.has(candidate.family)) ?? unused[0]
    if (!model) return null
    used.add(model.id)
    usedFamilies.add(model.family)
    return {
      id,
      label,
      note,
      model,
      // Clamped here for display only — selection above ranks by the raw score.
      score: clampScore(scoreRecommendedModel(model, hardware, now))
    }
  }

  const bestOverall = take(
    'overall',
    'Best Overall',
    'Best balance of quality, speed, and fit for this computer.',
    // `recommendation` names a size class, not a model, so there is nothing
    // here to pin: the best-scoring candidate for this machine is the answer.
    () => byScore
  )

  const bestCoding = take(
    'coding',
    'Best Coding',
    'Stronger for edits, project work, and tool-driven coding loops.',
    // No `byScore` tail here on purpose: if every genuinely coding-tagged
    // candidate is already claimed by an earlier slot, this should disappear
    // rather than mislabel a general-chat model as "Best Coding".
    () =>
      scored
        .filter(
          (entry) => entry.model.tags.includes('coding') || entry.model.primaryUse === 'coding'
        )
        .map((entry) => entry.model)
  )

  const bestAgent = take(
    'agent',
    'Best Agent',
    'Best pick for autonomous, tool-driven work — coding today, more agent tasks later.',
    // Only models that actually support tool-calling are eligible at all — a
    // model that can't reliably invoke tools has no business being "Best
    // Agent" regardless of how good its plain-chat quality is. No `byScore`
    // tail here either, for the same reason `bestCoding` has none: if every
    // tool-capable candidate is already claimed, this slot should disappear
    // rather than mislabel a non-tool-calling model as agent-ready.
    () =>
      scored
        .filter((entry) => entry.model.supportsTools)
        .map((entry) => ({
          model: entry.model,
          // Real observed reliability (from actually running this exact
          // model, matched by downloaded filename) meaningfully moves the
          // ranking beyond the static catalog score, since this project's own
          // testing found hardware fit alone doesn't predict whether a model
          // actually finishes tool-driven work. Blended rather than
          // overriding — a couple of rough turns on an otherwise-strong model
          // shouldn't permanently sink it, and a model with no usage history
          // yet is scored neutrally (no bonus, no penalty) rather than being
          // punished for having no data.
          rankScore: (() => {
            const reliabilityScore = agentContext
              ? reliabilityScoreForRecommended(
                  entry.model,
                  agentContext.installedModels,
                  agentContext.reliability
                )
              : null
            return reliabilityScore === null
              ? entry.score
              : entry.score + (reliabilityScore - 70) * 0.4
          })()
        }))
        .sort((a, b) => b.rankScore - a.rankScore)
        .map((entry) => entry.model)
  )

  const fastest = take(
    'fastest',
    'Fastest',
    'Best choice when quick responses matter more than maximum quality.',
    () =>
      [...speedCandidates]
        .sort((a, b) => speedRankOf(b.model) - speedRankOf(a.model) || b.score - a.score)
        .map((entry) => entry.model)
  )

  const largeContext = take(
    'large-context',
    'Large Context',
    'Best fit when the user needs bigger project memory.',
    () => {
      // Rank by the context size each candidate would *actually* get on this
      // hardware (see `contextSizeFor`), not by model size — most tiers
      // converge on the same context ceiling once there's enough RAM, so the
      // real differentiator is fit, not bulk. `scored` is already filtered to
      // RAM-eligible candidates above, so nothing further to exclude here.
      const ramGbForContext = hardware ? bytesToGb(hardware.ramBytes) : 0
      const vramGb = hardware?.vramBytes ? bytesToGb(hardware.vramBytes) : 0
      // Only a real dedicated GPU adds headroom beyond ramGb — on unified
      // memory it's already part of ramGb (double-counting it would inflate
      // the result), and there's nothing to offload the KV cache to without one.
      const effectiveVramGb = hardware && !hardware.unifiedMemory && vramGb >= 4 ? vramGb : 0

      // Re-sorts the same `scored` set (no `byScore` tail needed — this
      // already covers every candidate), so falling back within this list is
      // enough to guarantee whatever's picked is still genuinely tied for the
      // best achievable context, never just "next by overall score."
      return [...scored]
        .sort((a, b) => {
          const contextDiff =
            contextSizeFor(b.model.tier, ramGbForContext, effectiveVramGb) -
            contextSizeFor(a.model.tier, ramGbForContext, effectiveVramGb)
          return contextDiff !== 0 ? contextDiff : b.score - a.score
        })
        .map((entry) => entry.model)
    }
  )

  return [bestOverall, bestCoding, bestAgent, fastest, largeContext].filter(
    (slot): slot is RecommendedSlot => slot !== null
  )
}

export function scoreInstalledModel(model: ModelInfo, hardware: HardwareInfo): InstalledModelScore {
  const ramGb = bytesToGb(hardware.ramBytes)
  const vramGb = hardware.vramBytes ? bytesToGb(hardware.vramBytes) : 0
  const sizeGb = bytesToGb(model.sizeBytes)
  const quantScore = scoreQuant(model.quant)
  const familyScore = scoreModelFamily(model.name)
  const codingBonus = /coder|code|deepseek|qwen/i.test(model.name) ? 10 : 0
  const headroomGb = ramGb - sizeGb - 4

  let score = 54 + quantScore + familyScore + codingBonus
  score += Math.min(18, Math.max(-28, headroomGb * 2))
  if (hardware.gpu && vramGb >= Math.min(sizeGb * 0.75, 8)) score += 8
  if (sizeGb <= 3 && ramGb >= 8) score += 4
  if (sizeGb >= 9 && ramGb < 32) score -= 12
  if (sizeGb >= 18 && ramGb < 48) score -= 18

  const finalScore = clampScore(Math.round(score))
  const fit: InstalledModelScore['fit'] =
    finalScore >= 90 ? 'Excellent' : finalScore >= 78 ? 'Good' : finalScore >= 64 ? 'Fair' : 'Heavy'

  return {
    score: finalScore,
    fit,
    note:
      fit === 'Excellent'
        ? 'Best fit'
        : fit === 'Good'
          ? 'Strong local'
          : fit === 'Fair'
            ? 'Usable'
            : 'May be slow'
  }
}

function scoreQuant(quant?: string): number {
  const normalized = quant?.toLowerCase() ?? ''
  if (normalized.includes('q4_k_m')) return 16
  if (normalized.includes('q5')) return 14
  if (normalized.includes('q4')) return 13
  if (normalized.includes('q6')) return 12
  if (normalized.includes('q8')) return 8
  if (normalized.includes('q3')) return 6
  return 7
}

function scoreModelFamily(name: string): number {
  if (/qwen|deepseek|kimi|coder/i.test(name)) return 13
  if (/mistral|mixtral|codestral/i.test(name)) return 11
  if (/llama|gemma/i.test(name)) return 9
  if (/phi/i.test(name)) return 8
  return 6
}
