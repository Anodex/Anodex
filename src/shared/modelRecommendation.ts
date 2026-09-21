import { type ModelTier, type RecommendedModel } from './recommendedModels'
import { gpuMemoryGb, tierMemory, tierSizeGb } from './modelMemory'

/**
 * Maps detected hardware to the size of model it should run, and the runtime
 * settings that follow from it.
 *
 * Pure and dependency-free so it can run in either process and be unit-tested.
 *
 * This used to pick a named model out of a hand-written catalog. That catalog
 * is gone: a list of models to download is useless to a machine with no
 * network, which is the only situation it existed for, and it went stale the
 * moment it was written. What was left once the names were removed is the
 * part that was doing the work anyway — a ladder of size classes matched
 * against memory. Which *model* to offer is a separate question, answered
 * from the live catalog by `buildRecommendedSlots`.
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
 * Only the 14B/32B/70B bucket scales past 16,384: `pickTier` always takes the
 * largest tier the machine runs comfortably, so 7B/3B/1B get displaced long
 * before RAM would ever reach their own 32k/64k territory — those branches
 * would be unreachable. The top bucket has no larger tier to lose to, so it
 * is the one that persists as the ceiling however much memory there is.
 */
export function contextSizeFor(tier: ModelTier, ramGb: number, vramGb = 0): number {
  const usableGb = Math.max(0, ramGb - RESERVED_GB) + Math.max(0, vramGb - RESERVED_VRAM_GB)

  switch (tier) {
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

  const tier = pickTier(ramGb, gpuMemoryGb(ramGb, vramGb, hardware.unified))
  if (!tier) return null
  const contextSize = contextSizeFor(tier, ramGb, hasDedicatedGpu ? vramGb : 0)

  return {
    tier,
    contextSize,
    gpuLayers: 'auto',
    rationale: buildRationale(ramGb, vramGb, hasDedicatedGpu, tier, contextSize)
  }
}

function bytesToGb(bytes: number): number {
  return Math.max(0, bytes / GB)
}

/** Smallest first, so a search from the top finds the strongest that fits. */
const TIER_LADDER: ModelTier[] = ['1b', '3b', '7b', '14b', '32b', '70b']

/**
 * The largest size class this machine can hold.
 *
 * `minRamGb` is already a comfort floor rather than a bare file size — the
 * model, llama.cpp's own buffers, and three gigabytes for the operating
 * system — so meeting it means the thing runs, and the largest rung that
 * runs is the best answer to "what should this computer use".
 *
 * Comfort deliberately does *not* gate the choice, only the wording. Using
 * `idealRamGb` as a ceiling was the first version of this and it was wrong in
 * a way worth recording: at 7 GB the 1B rung became comfortable while the 3B
 * rung still only fitted, so the recommendation stepped *down* from 3B to 1B
 * as the machine got bigger. Any rule where a stricter test for a smaller
 * rung can outrank a looser one for a larger rung has that shape. So the
 * ladder is monotonic by construction and `buildRationale` says "fits, but
 * only just" when the ideal is not met.
 *
 * The top rung additionally has to fit in graphics memory. CPU inference is
 * bounded by memory bandwidth, so a 9GB model on a CPU is slow but usable
 * while a 42GB one is a couple of tokens a second, which is not a
 * recommendation — and a machine with a hundred gigabytes of system RAM and
 * no card is still a CPU-only machine, which is why this asks
 * `gpuMemoryGb` rather than `fastMemoryGb`. The old hand-written catalog encoded this
 * as `requiresGpuRecommended` with `minVramGb: 48` on its single 70B entry,
 * and deleting the catalog quietly deleted the rule with it — this machine
 * went straight to advertising "best target: 70B Q4" on a 24GB card. The
 * constraint belongs to the size, not to one row of a list, so it lives here
 * now and is derived from the tier's own reference size rather than from a
 * number somebody typed.
 */
export function pickTier(ramGb: number, gpuGb: number): ModelTier | null {
  const fits = TIER_LADDER.filter(
    (tier) => ramGb >= tierMemory(tier).minRamGb && (tier !== '70b' || gpuGb >= tierSizeGb('70b'))
  )
  return fits.length > 0 ? fits[fits.length - 1] : null
}

function buildRationale(
  ramGb: number,
  vramGb: number,
  hasDedicatedGpu: boolean,
  tier: ModelTier,
  contextSize: number
): string {
  const roundedRamGb = Math.round(ramGb)
  const gpu = hasDedicatedGpu ? ` and ${Math.round(vramGb)} GB VRAM` : ''
  // "a context of N tokens" rather than "a N-token context", which reads as
  // "a 8,192-token context" for every size whose leading digit is spoken
  // with "an".
  const context = `a context of ${contextSize.toLocaleString()} tokens`
  const { idealRamGb } = tierMemory(tier)

  if (ramGb < idealRamGb) {
    return (
      `Detected ${roundedRamGb} GB RAM${gpu}. ${tier.toUpperCase()} models fit, but only just — ` +
      `${idealRamGb} GB is where one runs comfortably, so expect ${context} and modest speed.`
    )
  }

  return (
    `Detected ${roundedRamGb} GB RAM${gpu}. Anodex suggests ${tier.toUpperCase()} models, ` +
    `the largest size this computer runs comfortably, with ${context}.`
  )
}
