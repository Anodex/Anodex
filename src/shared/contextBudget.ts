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
 * Maximum remembered output per past tool call when rebuilding model context.
 * Full tool details can remain in the UI transcript; this is the compact
 * model-facing replay limit.
 */
export const MAX_MODEL_TOOL_RESULT_CHARS = 1_200

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
