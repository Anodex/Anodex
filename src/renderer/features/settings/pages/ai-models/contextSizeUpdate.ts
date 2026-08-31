import type { ModelSettings, SettingsPatch } from '@shared/settings.types'

/**
 * The settings patch that saving a context size must produce.
 *
 * Extracted from `AiModelsSettings` so the rule can be tested without standing
 * up the whole page, and so it is stated once rather than living inside a
 * component closure.
 *
 * The rule has two halves and both matter:
 *
 * - **The global `model` block** keeps the visible control in step with what a
 *   freshly loaded model will default to.
 * - **The per-model entry** records the size against the model it was chosen
 *   for. Without it the number silently followed the *next* model into the
 *   engine — a size is only ever meaningful for the model it was picked for,
 *   and `resolveModelContextSize` reads the per-model entry first.
 *
 * A cloud model has no path to key an entry on, so only the global half
 * applies. Writing an entry under a null or empty key would be worse than
 * writing none: it would match nothing and quietly accumulate.
 */
export function contextSizeUpdate(
  patch: Partial<ModelSettings> & { contextSize: number },
  activeModelPath: string | null
): SettingsPatch {
  if (!activeModelPath) return { model: patch }
  return {
    model: patch,
    modelContextSizes: { [activeModelPath]: patch.contextSize }
  }
}
