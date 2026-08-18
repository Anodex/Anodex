import type { ModelInfo } from '@shared/model.types'
import type { HardwareInfo } from '@shared/system.types'
import type { RecommendedModel } from '@shared/recommendedModels'
import { RECOMMENDED_MODELS, recommendedModelFileName } from '@shared/recommendedModels'
import type { ModelRecommendation } from '@shared/modelRecommendation'
import { contextSizeFor, isModelHardwareCompatible } from '@shared/modelRecommendation'
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
 */
function fastestAppropriateCandidates(
  candidates: { model: RecommendedModel; score: number }[]
): { model: RecommendedModel; score: number }[] {
  const largestTier = Math.max(...candidates.map((candidate) => TIER_WEIGHT[candidate.model.tier]))
  const minimumTier = largestTier >= 32 ? 14 : largestTier >= 14 ? 7 : largestTier >= 7 ? 3 : 1
  return candidates.filter((candidate) => TIER_WEIGHT[candidate.model.tier] >= minimumTier)
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

export function hardwareFitLabel(hardware: HardwareInfo): string {
  const ramGb = bytesToGb(hardware.ramBytes)
  const vramGb = hardware.vramBytes ? bytesToGb(hardware.vramBytes) : 0
  if (ramGb >= 64 && (hardware.unifiedMemory || vramGb >= 16))
    return 'Excellent local AI fit · best target: 32B Q4 models'
  if (ramGb >= 32) return 'Strong local AI fit · best target: 14B Q4 or 7B Q4 models'
  if (ramGb >= 16) return 'Good local AI fit · best target: 7B Q4 models'
  if (ramGb >= 8) return 'Modest local AI fit · best target: 3B Q4 models'
  return 'Limited local AI fit · use small 1B models'
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
export function scoreRecommendedModel(
  model: RecommendedModel,
  hardware: HardwareInfo | null
): number {
  if (!hardware) return 70 + (model.qualityRank ?? 1) * 2

  const ramGb = bytesToGb(hardware.ramBytes)
  const vramGb = hardware.vramBytes ? bytesToGb(hardware.vramBytes) : 0
  const ramHeadroom = ramGb - model.minRamGb
  const idealRatio = model.idealRamGb ? Math.min(1, ramGb / model.idealRamGb) : 1

  let score = 48
  score += (model.qualityRank ?? 3) * 4
  score += (model.speedRank ?? 3) * 2
  score += idealRatio * 12
  score += Math.min(16, Math.max(-20, ramHeadroom * 1.5))
  if (model.primaryUse === 'coding' || model.primaryUse === 'agentic-coding') score += 8
  if (model.supportsTools) score += 5
  if (model.tags.includes('coding')) score += 4
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

  return Math.round(score)
}

/**
 * Merges the hand-vetted static catalog with a live Hugging Face pool for the
 * "Recommended for your PC" strip. The static list wins on a filename
 * collision (kept first) since it carries hand-verified `qualityRank`/
 * `speedRank`/`supportsTools` data a live entry can only estimate — so if a
 * live-discovered repo turns out to be the exact same downloadable file as an
 * already-curated entry, this doesn't show it twice with conflicting trust
 * levels.
 */
export function mergeCatalogs(
  staticCatalog: RecommendedModel[],
  liveCatalog: RecommendedModel[]
): RecommendedModel[] {
  const seen = new Set(staticCatalog.map((model) => recommendedModelFileName(model).toLowerCase()))
  const uniqueLive = liveCatalog.filter(
    (model) => !seen.has(recommendedModelFileName(model).toLowerCase())
  )
  return [...staticCatalog, ...uniqueLive]
}

export interface AgentReliabilityContext {
  installedModels: ModelInfo[]
  reliability: Map<string, ModelReliabilityRecord>
}

export function buildRecommendedSlots(
  hardware: HardwareInfo | null,
  recommendation: ModelRecommendation | null,
  agentContext?: AgentReliabilityContext,
  // Defaults to the static catalog alone so every existing caller/test
  // keeps working unchanged. The real UI passes the static catalog merged
  // with live Hugging Face results (see `RecommendedModelStrip.tsx`), so a
  // new model generation can outrank a stale hand-picked entry without an
  // Anodex code change.
  catalog: RecommendedModel[] = RECOMMENDED_MODELS
): RecommendedSlot[] {
  const allCandidates = catalog.filter((model) => model.recommended !== false)
  // Every card shares this strict eligibility gate. A model that misses its
  // catalog RAM or explicit GPU requirement must never appear as a safe
  // automatic choice; if nothing fits, the strip explains that rather than
  // suggesting an oversized fallback.
  const candidates = hardware
    ? allCandidates.filter((model) =>
        isModelHardwareCompatible(model, {
          ramBytes: hardware.ramBytes,
          vramBytes: hardware.vramBytes,
          unified: hardware.unifiedMemory
        })
      )
    : allCandidates
  if (candidates.length === 0) return []
  const scored = candidates
    .map((model) => ({ model, score: scoreRecommendedModel(model, hardware) }))
    .sort((a, b) => b.score - a.score)
  const byScore = scored.map((entry) => entry.model)
  const speedCandidates = fastestAppropriateCandidates(scored)

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
      score: clampScore(scoreRecommendedModel(model, hardware))
    }
  }

  const bestOverall = take(
    'overall',
    'Best Overall',
    'Best balance of quality, speed, and fit for this computer.',
    () => {
      const preferred = recommendation
        ? candidates.find((model) => model.id === recommendation.modelId)
        : undefined
      return preferred ? [preferred, ...byScore] : byScore
    }
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
        .sort((a, b) => (b.model.speedRank ?? 0) - (a.model.speedRank ?? 0) || b.score - a.score)
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
            contextSizeFor(b.model, ramGbForContext, effectiveVramGb) -
            contextSizeFor(a.model, ramGbForContext, effectiveVramGb)
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
