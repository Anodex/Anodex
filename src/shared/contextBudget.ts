/**
 * Shared context-budget knobs used by both the main-process assembler and the
 * renderer's projected context meter.
 *
 * These values describe Anodex's model-facing projection, not the persisted
 * chat transcript. Keeping them shared prevents the UI from displaying a
 * different context story than the engine actually uses.
 */

export const RESERVED_NON_HISTORY_FRACTION = 0.2
export const MIN_RESERVED_NON_HISTORY_TOKENS = 512
export const MAX_RESERVED_NON_HISTORY_TOKENS = 8192

/**
 * Manual compaction keeps this many newest turns verbatim. The summary covers
 * everything older, so the user can clean the context before a new phase
 * without sacrificing the immediate back-and-forth that often contains
 * unresolved details.
 */
export const MANUAL_COMPACTION_RECENT_TURNS = 6

/**
 * Maximum remembered output per past tool call when rebuilding model context.
 * Full tool details can remain in the UI transcript; this is the compact
 * model-facing replay limit.
 */
export const MAX_MODEL_TOOL_RESULT_CHARS = 1_200

/**
 * Conservative context-window fallback for a cloud model with no known
 * `contextWindowTokens` entry (e.g. a custom/typed-in model override). Well
 * below every current OpenAI/Anthropic model's real window so an unrecognized
 * model still gets bounded instead of replaying history unboundedly.
 */
export const DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS = 128_000

/** Non-history token reservation for the given context window. */
export function reservedNonHistoryTokens(contextSize: number): number {
  return Math.min(
    MAX_RESERVED_NON_HISTORY_TOKENS,
    Math.max(
      MIN_RESERVED_NON_HISTORY_TOKENS,
      Math.round(contextSize * RESERVED_NON_HISTORY_FRACTION)
    )
  )
}
