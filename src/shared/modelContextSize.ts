import type { AppSettings } from './settings.types'

/**
 * The context size a given model should actually load at.
 *
 * A context size is only meaningful for the model it was sized against — the
 * "Apply recommendation" button reads that specific file's GGUF metadata and
 * the host's memory. `model.contextSize` is nevertheless a single global
 * number, so a size chosen for one model silently became the size for every
 * model: sizing a 27B vision model down to 8,192 left a small coding model
 * loading at 8,192 too, with a 427-token history budget, no warning anywhere,
 * and a tool loop that hit its context checkpoint after a single call — the
 * running size still matched the saved setting exactly, so every consistency
 * check in the UI agreed everything was fine.
 *
 * A per-model entry therefore wins over the global setting. The global remains
 * the default for every model that was never sized deliberately, which is most
 * of them.
 */
export function resolveModelContextSize(
  settings: Pick<AppSettings, 'model' | 'modelContextSizes'> | null | undefined,
  modelPath: string | null | undefined,
  override?: number
): number | undefined {
  if (override !== undefined) return override
  if (!settings) return undefined

  const remembered = modelPath == null ? undefined : settings.modelContextSizes?.[modelPath]
  return remembered ?? settings.model?.contextSize
}
