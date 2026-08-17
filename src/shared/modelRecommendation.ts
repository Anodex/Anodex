import { RECOMMENDED_MODELS, type ModelTier, type RecommendedModel } from './recommendedModels'

/**
 * Maps detected hardware to a recommended model + runtime settings.
 *
 * Pure and dependency-free so it can run in either process and be unit-tested.
 * The catalog is the source of truth for hard RAM eligibility. Scoring then
 * decides which compatible model is the best default for Anodex's local-first
 * coding workflow.
 */

export interface HardwareProfile {
  /** Total system RAM in bytes. */
  ramBytes: number
  /** Total GPU VRAM in bytes, or null if unknown/none. */
  vramBytes: number | null
  /** True on unified-memory systems (Apple Silicon) where VRAM shares RAM. */
  unified: boolean
}

export interface ModelRecommendation {
  tier: ModelTier
  modelId: string
  modelName: string
  contextSize: number
  gpuLayers: 'auto'
  /** Human-readable explanation shown in the UI. */
  rationale: string
}

const GB = 1024 ** 3
/** Headroom reserved for the OS and the app itself when choosing context. */
const RESERVED_GB = 3
/** Headroom reserved on the GPU side (display buffers, driver overhead) — smaller
 * than `RESERVED_GB` since a GPU doesn't need to run an OS the way system RAM does. */
const RESERVED_VRAM_GB = 2
const DEFAULT_CONTEXT_SIZE = 4096
/** Largest context Anodex will auto-recommend. Bigger models cost more KV-cache
 * memory per token, so heavier tiers need more headroom to reach the same size —
 * smaller models can reach it on much more modest hardware. Raised past 131,072
 * for workstations with half a terabyte of unified memory, which can hold far
 * more than the old ceiling allowed them to ask for. */
const CONTEXT_CEILING = 1048576

const TIER_WEIGHT: Record<ModelTier, number> = {
  '1b': 1,
  '3b': 3,
  '7b': 7,
  '14b': 14,
  '32b': 32,
  '70b': 70
}

/**
 * Context size (tokens) per selected model, scaled by how much memory
 * headroom is left after the model itself — RAM plus, when a dedicated GPU
 * is present, its VRAM too. A discrete GPU can host the KV cache
 * independently of system RAM (that's the whole point of GPU offload), so
 * ignoring it — as this used to — meant a machine with a strong GPU and only
 * middling RAM was recommended the same small context as one with no GPU at
 * all. `vramGb` should be `0` for CPU-only and unified-memory systems (on
 * unified memory it's already reflected in `ramGb`, so adding it again would
 * double-count the same physical memory).
 *
 * Only the 14B/32B/70B bucket scales past 16,384: `scoreModel` below always
 * prefers the strongest coding-capable tier once RAM allows it, so 7B/3B/1B
 * get displaced by a larger tier long before RAM would ever reach their own
 * 32k/64k+ territory — those branches would be unreachable dead code. The
 * top bucket has no larger tier to lose to (the catalog's only 70B entry is
 * a general-chat model that `scoreModel`'s coding bonuses always rank below
 * 32B — see `buildRationale`'s "coding-first" framing), so it's the one
 * tier that persists as the ceiling no matter how much RAM is available.
 */
export function contextSizeFor(model: RecommendedModel, ramGb: number, vramGb = 0): number {
  const usableGb = Math.max(0, ramGb - RESERVED_GB) + Math.max(0, vramGb - RESERVED_VRAM_GB)

  switch (model.tier) {
    case '70b':
    case '32b':
    case '14b':
      // Rungs at and below 256 GB are deliberately unchanged: raising what an
      // existing machine is told to use would double its KV cache on an app
      // update, which is how a working setup starts failing to load. The new
      // rungs only add reach above where the ladder used to stop.
      if (usableGb >= 1024) return CONTEXT_CEILING
      if (usableGb >= 512) return 524288
      if (usableGb >= 384) return 262144
      if (usableGb >= 256) return 131072
      if (usableGb >= 128) return 65536
      if (usableGb >= 64) return 32768
      return 16384
    case '7b':
      return usableGb >= 20 ? 16384 : 8192
    case '3b':
      return usableGb >= 7 ? 8192 : DEFAULT_CONTEXT_SIZE
    case '1b':
      return usableGb >= 3 ? DEFAULT_CONTEXT_SIZE : 2048
  }
}

/**
 * A hard gate for automatic recommendations. `minRamGb` is deliberately a
 * comfort floor, not just the bare model-file size: if a machine misses it,
 * Anodex must not surface the model as a safe default. Models that explicitly
 * require a GPU are similarly withheld unless the machine has qualifying
 * dedicated or unified graphics memory.
 */
export function isModelHardwareCompatible(
  model: RecommendedModel,
  hardware: HardwareProfile
): boolean {
  const ramGb = bytesToGb(hardware.ramBytes)
  if (ramGb < model.minRamGb) return false
  if (!model.requiresGpuRecommended) return true

  const vramGb = hardware.vramBytes ? bytesToGb(hardware.vramBytes) : 0
  const minimumGpuGb = model.minVramGb ?? 4
  return hardware.unified || vramGb >= minimumGpuGb
}

export function recommendModel(hardware: HardwareProfile): ModelRecommendation | null {
  const ramGb = bytesToGb(hardware.ramBytes)
  const vramGb = hardware.vramBytes ? bytesToGb(hardware.vramBytes) : 0
  const hasDedicatedGpu = !hardware.unified && vramGb >= 4

  const model = pickBestModel(ramGb, vramGb, hasDedicatedGpu, hardware.unified)
  if (!model) return null
  const contextSize = contextSizeFor(model, ramGb, hasDedicatedGpu ? vramGb : 0)

  return {
    tier: model.tier,
    modelId: model.id,
    modelName: model.name,
    contextSize,
    gpuLayers: 'auto',
    rationale: buildRationale(ramGb, vramGb, hasDedicatedGpu, model, contextSize)
  }
}

function bytesToGb(bytes: number): number {
  return Math.max(0, bytes / GB)
}

function pickBestModel(
  ramGb: number,
  vramGb: number,
  hasDedicatedGpu: boolean,
  unified: boolean
): RecommendedModel | null {
  const candidates = RECOMMENDED_MODELS.filter(
    (model) =>
      model.recommended !== false &&
      isModelHardwareCompatible(model, {
        ramBytes: ramGb * GB,
        vramBytes: vramGb ? vramGb * GB : null,
        unified
      })
  )

  if (candidates.length === 0) return null

  return candidates.reduce((best, model) => {
    return scoreModel(model, ramGb, vramGb, hasDedicatedGpu) >
      scoreModel(best, ramGb, vramGb, hasDedicatedGpu)
      ? model
      : best
  }, candidates[0])
}

function scoreModel(
  model: RecommendedModel,
  ramGb: number,
  vramGb: number,
  hasDedicatedGpu: boolean
): number {
  const quality = model.qualityRank ?? TIER_WEIGHT[model.tier]
  const speed = model.speedRank ?? 3
  const headroomGb = Math.max(0, ramGb - model.minRamGb)
  const idealHeadroom = model.idealRamGb ? Math.min(1, ramGb / model.idealRamGb) : 1

  let score = quality * 12 + speed * 3 + Math.min(headroomGb, 24) + idealHeadroom * 10

  if (model.primaryUse === 'coding' || model.primaryUse === 'agentic-coding') score += 42
  if (model.tags.includes('coding')) score += 20
  if (model.supportsTools) score += 16
  if (model.stable !== false) score += 8

  if (model.requiresGpuRecommended && !hasDedicatedGpu) score -= 45
  if (model.minVramGb && hasDedicatedGpu && vramGb >= model.minVramGb) score += 14
  if (model.minVramGb && hasDedicatedGpu && vramGb < model.minVramGb) score -= 10

  // Large CPU-only models may technically load, but they make a poor default
  // coding experience because every edit/verify loop feels slow.
  if (!hasDedicatedGpu && TIER_WEIGHT[model.tier] >= 32) score -= 12
  if (!hasDedicatedGpu && TIER_WEIGHT[model.tier] >= 70) score -= 36

  return score
}

function buildRationale(
  ramGb: number,
  vramGb: number,
  hasDedicatedGpu: boolean,
  model: RecommendedModel,
  contextSize: number
): string {
  const roundedRamGb = Math.round(ramGb)
  const gpu = hasDedicatedGpu ? ` and ${Math.round(vramGb)} GB VRAM` : ''
  const purpose = model.primaryUse === 'general' ? 'general chat' : 'coding'
  const context = `${contextSize.toLocaleString()}-token context`

  if (ramGb < model.minRamGb) {
    return (
      `Detected ${roundedRamGb} GB RAM${gpu}. ${model.name} is the smallest local model in the catalog, ` +
      `but this computer is below the recommended ${model.minRamGb} GB RAM minimum, so performance may be limited.`
    )
  }

  return (
    `Detected ${roundedRamGb} GB RAM${gpu}. Anodex recommends ${model.name} for ${purpose} ` +
    `because it is the strongest compatible model expected to run comfortably here at a ${context}.`
  )
}
