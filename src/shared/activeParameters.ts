import type { ModelTier } from './recommendedModels'

/**
 * How many billion parameters a model computes with for each word, when its
 * name says so, or null.
 *
 * A model's file size says how much memory it needs; it does not say how fast
 * it answers when the file stores more than each word uses. Two naming
 * conventions say so outright, across families:
 *
 * - **`E<n>B`, effective.** Per-layer-embedding models (Gemma 3n and 4's
 *   `E2B`, `E4B`) carry embeddings the processor looks up rather than
 *   multiplies through. `gemma-4-E4B` is a 5.7 GB file that computes like a
 *   4B model.
 * - **`A<n>B`, active.** Mixture-of-experts models (`Qwen3-30B-A3B`,
 *   `gemma-4-26B-A4B`) route each word through a few experts: 30 billion
 *   stored, 3 billion working.
 *
 * Measured on a Windows laptop with integrated graphics: Gemma 4 E4B answered
 * a suite of questions faster than Llama 3.1 8B, a smaller file, while the
 * scorer, reading only file sizes, ranked Llama "Fastest".
 *
 * Read only as a whole name segment (`-A3B-`, `_E4B.`) so a word that merely
 * contains the letters is not taken for one.
 */
export function activeParametersB(name: string): number | null {
  const match = /(?:^|[-_.\s/])[AE](\d+(?:\.\d+)?)B(?=$|[-_.\s/])/i.exec(name)
  if (!match) return null
  const billions = Number.parseFloat(match[1] ?? '')
  return Number.isFinite(billions) && billions > 0 ? billions : null
}

/**
 * The size class a model computes like, from its active parameters. Bounds
 * sit between the parameter counts the classes are named for, so a 4B lands
 * with the 3B class and an 8B with the 7B class, as their file sizes do.
 */
export function tierForParametersB(billions: number): ModelTier {
  if (billions <= 2) return '1b'
  if (billions <= 5) return '3b'
  if (billions <= 10) return '7b'
  if (billions <= 20) return '14b'
  if (billions <= 45) return '32b'
  return '70b'
}
