/**
 * Every context size Anodex exposes, smallest to largest. The single source
 * of truth for both the manual "Context size" dropdown and the hardware-based
 * per-model recommender, so the two can never quietly drift out of sync.
 *
 * The top two rungs exist because Anodex runs on whatever the user owns, and
 * that now includes 512 GB unified-memory workstations and multi-GPU boxes.
 * Capping the ladder below what such a machine can hold would waste the memory
 * the user paid for. Nothing downstream may assume a maximum: every context
 * budget is a fraction of `contextSize` with a floor and a ceiling, so adding a
 * rung here is arithmetic, not a new case to handle — see `contextBudget.ts`.
 */
export const CONTEXT_SIZE_LADDER = [
  2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576
] as const

export function formatContextSizeLabel(tokens: number): string {
  return `${tokens.toLocaleString()} tokens`
}
