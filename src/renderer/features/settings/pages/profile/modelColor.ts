/**
 * Deterministic color for a model id — the same id always produces the same
 * color, so a model's dot in the breakdown list and its stack segment in the
 * chart always visually match. Hash-based hue (not a fixed palette) so an
 * arbitrary number of distinct models stays visually distinguishable instead
 * of running out of/repeating colors.
 *
 * This is a deliberate exception to "always use theme.css tokens" — per-model
 * colors are inherently data-driven (an arbitrary, unbounded set), not
 * theme-driven, the same way GitHub's own per-language color dots aren't
 * theme tokens either. Saturation/lightness are tuned to read clearly
 * against both `--bg-surface`/`--bg-surface-2` in dark and light mode —
 * verified visually during live testing, not derived from a formula.
 */
export function colorForModel(modelId: string): string {
  let hash = 0
  for (let i = 0; i < modelId.length; i++) {
    hash = (hash * 31 + modelId.charCodeAt(i)) >>> 0
  }
  const hue = hash % 360
  return `hsl(${hue}, 65%, 58%)`
}
