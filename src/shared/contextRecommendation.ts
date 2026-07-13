/**
 * Pure decision logic for picking a recommended context size, kept separate
 * from the native GGUF reading/estimation (see `LlamaService.recommendSettingsForFile`)
 * so it's easy to unit-test without mocking `node-llama-cpp`.
 */

export interface ContextSizeCandidate {
  contextSize: number
  /**
   * Whether this context size actually fits on the hardware. A plain boolean
   * rather than a single byte budget because "fits" can depend on more than
   * one resource pool at once (e.g. RAM *and* VRAM when a dedicated GPU is
   * offloading part of the model) — the caller does that resource-specific
   * math and hands back a yes/no per candidate.
   */
  fits: boolean
}

/**
 * Picks the largest candidate that fits, capped by `trainContextSize` when
 * the model's own GGUF metadata reports one — recommending more than a model
 * was actually trained on doesn't help, regardless of how much memory is
 * free. Falls back to the smallest candidate if none fit; this is a
 * *suggestion*, not a safety gate — `describeInsufficientMemory` is what
 * actually blocks a load that won't fit.
 */
export function pickRecommendedContextSize(
  candidates: readonly ContextSizeCandidate[],
  trainContextSize: number | undefined
): number {
  const eligible = candidates.filter(
    (c) => c.fits && (trainContextSize === undefined || c.contextSize <= trainContextSize)
  )

  if (eligible.length === 0) {
    return candidates.reduce((smallest, c) => (c.contextSize < smallest.contextSize ? c : smallest))
      .contextSize
  }

  return eligible.reduce((best, c) => (c.contextSize > best.contextSize ? c : best)).contextSize
}
