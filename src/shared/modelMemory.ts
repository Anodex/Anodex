import type { ModelTier } from './recommendedModels'

/**
 * Estimated RAM needed to run a model of this file size.
 *
 * This was `size * 2.8 + 3`, inherited from the curated catalog's own
 * size-to-RAM ratios and deliberately generous, on the reasoning that
 * over-estimating only costs caution while under-estimating risks an OOM
 * crash. The caution turned out not to be free. Three real llama.cpp load
 * reports, all at an 8192 context:
 *
 * | model                  | file     | weights  | KV      | compute | total    | old estimate |
 * | ---------------------- | -------- | -------- | ------- | ------- | -------- | ------------ |
 * | Qwen3-4B Q4_K_M        | 2.33 GiB | 2.62 GiB | 1.13 GiB| 0.10 GiB| 3.85 GiB | 10 GB        |
 * | Devstral-Small Q4_K_M  | 13.4 GiB | 13.3 GiB | 1.25 GiB| 0.26 GiB| 14.9 GiB | 41 GB        |
 * | Qwen3.8-27B Q4_K_M     | 15.3 GiB | 15.0 GiB | 0.65 GiB| 0.43 GiB| 16.1 GiB | 49 GB        |
 *
 * So the old figure over-stated the real requirement by 2.6x to 3.0x across
 * the whole range, and the cost was not caution — it was that a 32GB gaming
 * PC was told it could not run a 27B model that in fact needs 16GB, and was
 * offered 3B models instead. On a 16GB laptop the only things left standing
 * were toys.
 *
 * What the reports actually show: weights track the file almost exactly, and
 * everything else (KV cache, compute buffers, output) lands between 0.6 and
 * 1.4 GiB regardless of model size. The 1.2 multiplier covers that overhead
 * with room to spare; the +3 is the operating system's own working set, since
 * this is compared against *total* RAM rather than free RAM. Every measured
 * model lands above its real requirement — the 27B comes out at 22 GB against
 * a measured 16.1, the Devstral at 19 against 14.9 — without pricing
 * mid-range machines out.
 *
 * The constant is 3 rather than 5 because the reserve has to stay smaller
 * than the smallest machine anyone runs this on: at +5 a 1B model needed 6GB
 * and a 4GB netbook was offered nothing at all, which is worse than offering
 * it the one model it can just about hold.
 */
export function estimateRamRequirements(sizeBytes: number): {
  minRamGb: number
  idealRamGb: number
} {
  const sizeGb = sizeBytes / 1024 ** 3
  const minRamGb = Math.ceil(sizeGb * 1.2 + 3)
  const idealRamGb = Math.ceil(sizeGb * 1.4 + 5)
  return { minRamGb, idealRamGb }
}

/**
 * A representative Q4_K_M download size for each tier, in GB.
 *
 * Tiers are named after parameter counts, but what a machine has to hold is
 * bytes — so every memory question about a tier goes through a real file
 * size. These are the sizes Anodex has actually seen for each rung, and they
 * are what `tierMemory` turns into the same min/ideal figures a live model
 * gets from its own file. The point is that one machine is judged against one
 * rule whether it is being offered a specific model or a tier.
 */
const TIER_REFERENCE_SIZE_GB: Record<ModelTier, number> = {
  '1b': 0.8,
  '3b': 2.0,
  '7b': 4.7,
  '14b': 9.0,
  '32b': 19.8,
  '70b': 42.5
}

/** What a tier asks of a machine, on the same rule as a real model file. */
export function tierMemory(tier: ModelTier): { minRamGb: number; idealRamGb: number } {
  return estimateRamRequirements(TIER_REFERENCE_SIZE_GB[tier] * 1024 ** 3)
}

/** A tier's representative file size, for questions about where it has to fit. */
export function tierSizeGb(tier: ModelTier): number {
  return TIER_REFERENCE_SIZE_GB[tier]
}

/**
 * Memory a *graphics* processor can reach, in GB — a card, or the whole of
 * an Apple machine's unified pool. Zero on a CPU-only machine and on one
 * whose only adapter is an integrated chip too small to hold anything.
 *
 * Distinct from {@link fastMemoryGb}, which falls back to a share of system
 * RAM because its question is "how big should a model be to use this
 * machine". This one's question is "can a GPU actually run it", and system
 * RAM is not an answer to that however much of it there is.
 */
export function gpuMemoryGb(ramGb: number, vramGb: number, unified: boolean): number {
  if (unified) return ramGb
  return vramGb >= 4 ? vramGb : 0
}

/**
 * The memory a model can run *fast* in, in GB.
 *
 * A graphics card only decides this when there is enough of it to hold a
 * model worth running. Below the four-gigabyte bar the card is an integrated
 * one sharing system memory, and llama.cpp puts most of the layers in RAM
 * regardless — so measuring against its one or two gigabytes made a 0.6B
 * model look like a perfect fit for a laptop and a 9B model look like it
 * overflowed. Measured: on 16GB with a 1GB iGPU that was a 19-point swing in
 * the toy model's favour, and it won Best Overall.
 *
 * System memory is discounted because it is never all available, and is
 * slower than a card besides.
 */
export function fastMemoryGb(ramGb: number, vramGb: number, unified: boolean): number {
  if (unified) return ramGb * 0.7
  return vramGb >= 4 ? vramGb : ramGb * 0.6
}
