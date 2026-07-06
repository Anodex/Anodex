/**
 * Usage-based reliability tracking for local models — distinct from the
 * hardware-fit scoring in `modelRecommendation.ts`. A model can be a great fit
 * for a machine and still be unreliable at actually finishing tasks (the
 * project's own testing found local 3B/7B models frequently mis-call tools or
 * claim a change was made when it wasn't); this tracks that directly from
 * real tool-call outcomes instead of guessing from spec sheets.
 */

/** Success/error tally for one tool name (e.g. `write_file`, `run_command`). */
export interface ToolReliabilityStats {
  successes: number
  errors: number
}

/** Aggregated usage-based reliability for one local model, persisted across sessions. */
export interface ModelReliabilityRecord {
  /** Matches `ModelInfo.id` (a hash of the model's file path). */
  modelId: string
  /** Display name, kept even if the model file is later removed or renamed. */
  modelName: string
  /**
   * The model's on-disk filename (e.g. `qwen2.5-coder-14b-instruct-q4_k_m.gguf`),
   * unlike `modelId` (a per-machine path hash) this is the same across
   * different users who downloaded the same repo+quant — the natural key for
   * a future feature that aggregates reliability signal across users, which
   * isn't built yet but shouldn't require a data migration when it is.
   */
  fileName?: string
  /** Per-tool-name success/error counts. Denied calls are excluded — a user
   * denial reflects the user's choice, not the model's competence. */
  byTool: Record<string, ToolReliabilityStats>
  /**
   * Times the model claimed an outcome (a file change, an approval, a denial)
   * that did not actually happen that turn — see `looksLikeUnactedIntent` and
   * `looksLikeFabricatedOutcome` in `toolCallFallback.ts`. A strong signal of
   * a poor model independent of whether its few real tool calls succeeded.
   */
  fabrications: number
  lastUsedAt: number
}

/** Below this many observed tool-call outcomes, a score would be noise — show "not enough data" instead. */
export const MIN_ATTEMPTS_FOR_RELIABILITY_SCORE = 3

/** Points subtracted per fabrication, capped so one bad turn can't zero out an otherwise-solid record. */
const FABRICATION_PENALTY_PER_EVENT = 5
const MAX_FABRICATION_PENALTY = 30

/**
 * A 0-100 reliability score from a model's recorded usage, or `null` when
 * there isn't enough data yet (rather than showing a misleadingly precise
 * number from one or two calls).
 */
export function computeReliabilityScore(record: ModelReliabilityRecord | undefined): number | null {
  if (!record) return null
  let successes = 0
  let errors = 0
  for (const stats of Object.values(record.byTool)) {
    successes += stats.successes
    errors += stats.errors
  }
  const attempts = successes + errors
  if (attempts < MIN_ATTEMPTS_FOR_RELIABILITY_SCORE) return null

  const successRate = (successes / attempts) * 100
  const fabricationPenalty = Math.min(
    MAX_FABRICATION_PENALTY,
    record.fabrications * FABRICATION_PENALTY_PER_EVENT
  )
  return Math.max(0, Math.round(successRate - fabricationPenalty))
}
