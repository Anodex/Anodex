import type { ModelLoadOptions } from '@shared/model.types'

/**
 * Everything about a load request that changes what ends up in the engine.
 *
 * Two calls matching on all of it want the same engine, so the second can wait
 * for the first instead of being refused — which is what startup does to
 * itself when something restores the last model while something else asks for
 * it. Two calls differing in any of it do not match: a different window or a
 * different GPU split is a different load, and coalescing those would silently
 * hand the second caller settings it never asked for.
 *
 * Its own module so it can be tested without importing the engine.
 */
export function describeLoad(options: ModelLoadOptions): string {
  return JSON.stringify([
    options.path,
    options.visionProjectorPath ?? null,
    options.contextSize ?? null,
    options.gpuLayers ?? null,
    options.parallelJobs ?? null
  ])
}
