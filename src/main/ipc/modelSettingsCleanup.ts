import type { AppSettings, SettingsPatch } from '@shared/settings.types'

/**
 * The settings a deleted model leaves behind, and how to clear them.
 *
 * Deleting a model file has to forget everything recorded *about* that model,
 * or the entries outlive the file. The delete handler already cleared three of
 * them and missed `modelContextSizes`, which is the one that matters most: a
 * context size is only meaningful for the model it was chosen for, and it is
 * read back by path.
 *
 * `null` is the removal sentinel — settings patches are deep-merged, so a copy
 * with the key omitted leaves the stale entry in place forever. Both open
 * records are registered in `REMOVABLE_SETTING_PATHS`, which is what makes the
 * sentinel work at all.
 *
 * Returns `null` when the model left nothing behind, so a delete of an
 * unconfigured model does not write a settings patch for no reason.
 */
export function forgetModelSettings(settings: AppSettings, path: string): SettingsPatch | null {
  const known =
    settings.addedModelPaths.includes(path) ||
    settings.lastModelPath === path ||
    Boolean(settings.visionProjectorPaths?.[path]) ||
    settings.modelContextSizes?.[path] !== undefined

  if (!known) return null

  return {
    addedModelPaths: settings.addedModelPaths.filter((candidate) => candidate !== path),
    lastModelPath: settings.lastModelPath === path ? null : settings.lastModelPath,
    visionProjectorPaths: { [path]: null },
    modelContextSizes: { [path]: null }
  }
}
