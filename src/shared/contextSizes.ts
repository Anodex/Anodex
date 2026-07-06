/**
 * Every context size Anodex exposes, smallest to largest. The single source
 * of truth for both the manual "Context size" dropdown and the hardware-based
 * per-model recommender, so the two can never quietly drift out of sync.
 */
export const CONTEXT_SIZE_LADDER = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144] as const

export function formatContextSizeLabel(tokens: number): string {
  return `${tokens.toLocaleString()} tokens`
}
