/**
 * A small palette of on-brand blue/violet tones (variations on
 * `--accent`/`--accent-violet` from theme.css), not an arbitrary hue —
 * assigning colors from the full 360° hue wheel could land on anything
 * (including red/pink), which clashes with Anodex's own palette. This is
 * still a deliberate exception to "always use theme.css tokens": per-model
 * colors are inherently data-driven (an arbitrary, unbounded set), so a
 * fixed set of on-brand hex values — not a token reference — is the right
 * tool here, the same way GitHub's own per-language color dots aren't theme
 * tokens either. Chosen to read clearly against both `--bg-surface`/
 * `--bg-surface-2` in dark and light mode — verified visually during live
 * testing, not derived from a formula.
 */
const MODEL_COLOR_PALETTE = [
  '#4f8cff', // accent blue
  '#7c5cff', // accent violet
  '#38bdf8', // sky
  '#a78bfa', // light violet
  '#22d3ee', // cyan
  '#818cf8' // indigo
]

/**
 * Deterministic color for a model id — the same id always produces the same
 * palette entry, so a model's dot in the breakdown list and its stack
 * segment in the chart always visually match, and stay stable even if the
 * model's rank in the breakdown list changes.
 */
export function colorForModel(modelId: string): string {
  let hash = 0
  for (let i = 0; i < modelId.length; i++) {
    hash = (hash * 31 + modelId.charCodeAt(i)) >>> 0
  }
  return MODEL_COLOR_PALETTE[hash % MODEL_COLOR_PALETTE.length]
}
