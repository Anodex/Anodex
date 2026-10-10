import type { HardwareInfo } from '@shared/system.types'
import type { RecommendedModel } from '@shared/recommendedModels'
import { modelSizeGb } from '../settings/pages/ai-models/scoring'

/**
 * Room to spare beyond the model itself. The download is written beside its
 * final name and renamed, so it needs its own size; this covers the projector,
 * rounding in the catalog's stated size, and the disk not being left at zero.
 */
const HEADROOM_BYTES = 512 * 1024 ** 2

/**
 * How many bytes short the models drive is for downloading `model`, or 0 when
 * it fits or free space is unknown. Unknown is not "full": a machine that
 * cannot report free space should still be able to try.
 */
export function downloadShortfallBytes(
  hardware: Pick<HardwareInfo, 'storageFreeBytes'> | null,
  model: RecommendedModel
): number {
  const free = hardware?.storageFreeBytes
  if (free === null || free === undefined) return 0
  const needed = modelSizeGb(model) * 1024 ** 3 + HEADROOM_BYTES
  return Math.max(0, Math.ceil(needed - free))
}
