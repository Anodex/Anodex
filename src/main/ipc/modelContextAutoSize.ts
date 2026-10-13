import type { AppSettings } from '@shared/settings.types'

/**
 * Whether a load should be sized for this model rather than inherit the
 * global context size.
 *
 * The first launch sizes `model.contextSize` from the hardware for whichever
 * model it recommends, and every model without a size of its own inherited that
 * number: a machine recommended a 7B kept the 7B's window for a 27B that could
 * not hold it, and a large card kept a small model at a fraction of what it
 * could run. Such a model is sized at each load to the largest window that fits
 * the memory free then (`largestFittingContextSize`), up to 32,768 tokens.
 *
 * Not remembered: a size worked out while something else held memory would
 * otherwise stick to the model after that memory came free.
 *
 * Never applied when somebody chose a size: a model that has a size of its own
 * keeps it, and a caller asking for anything other than the global default
 * (a phone or a test naming its own size) gets what it asked for. Not applied
 * to vision models either, whose projector memory the per-file figure does not
 * count.
 */
export function shouldSizeForModel({
  settings,
  modelPath,
  requestedContextSize,
  hasVisionProjector
}: {
  settings: Pick<AppSettings, 'model' | 'modelContextSizes'>
  modelPath: string
  requestedContextSize: number | undefined
  hasVisionProjector: boolean
}): boolean {
  if (hasVisionProjector) return false
  if (settings.modelContextSizes?.[modelPath] !== undefined) return false
  return requestedContextSize === undefined || requestedContextSize === settings.model.contextSize
}
