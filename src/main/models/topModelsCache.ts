import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseJsonText } from '../utils/jsonFile'
import { writeJsonAtomicAsync } from '../utils/atomicWrite'
import { createLogger } from '../utils/logger'
import type { RecommendedModel } from '@shared/recommendedModels'

const log = createLogger('top-models-cache')

const FILE_NAME = 'top-models.json'
/**
 * Bumped whenever a cached entry would be read on a different scale than it
 * was written on — most importantly when `estimateRamRequirements` changes,
 * since every cached model carries the `minRamGb` its own build computed and
 * ranking compares that against today's curated figures.
 */
const FORMAT = 1

interface CacheFile {
  format: number
  at: number
  models: RecommendedModel[]
}

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/**
 * The last live model list that actually arrived, kept on disk.
 *
 * `fetchTopModels` caches in memory for fifteen minutes, which does nothing
 * for the case that matters: every launch starts with nothing, and a launch
 * that cannot reach Hugging Face keeps nothing. The recommendation then falls
 * back to the built-in catalog, and the built-in catalog is hand-written —
 * on the day this was added every entry in it was between twenty and
 * twenty-eight months old, so an offline user was told the best model for
 * their machine was Qwen2.5 Coder 32B, from November 2024.
 *
 * A list from last week is a far better answer to "what should I run" than a
 * list from two years ago, so the last good fetch is written here and served
 * whenever a fresh one cannot be had. Deliberately without an expiry: a
 * six-month-old cache still beats the built-in list, and discarding it would
 * only put the user back where this started.
 */
export async function rememberTopModels(models: RecommendedModel[]): Promise<void> {
  if (models.length === 0) return
  try {
    const payload: CacheFile = { format: FORMAT, at: Date.now(), models }
    await writeJsonAtomicAsync(filePath(), payload)
  } catch (error) {
    // Losing the cache costs a stale recommendation, not a broken app.
    log.warn('Could not write the top-models cache', String(error))
  }
}

/** The remembered list, or null when there is none this build can read. */
export async function recallTopModels(): Promise<RecommendedModel[] | null> {
  let parsed: unknown
  try {
    parsed = parseJsonText(await readFile(filePath(), 'utf-8'))
  } catch {
    // No cache yet is the ordinary first-launch case, not a problem.
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const file = parsed as Partial<CacheFile>
  // An older format was written on a different scale; served as-is it would
  // rank unfairly against today's curated entries. Dropping it costs one
  // fetch, and if that fetch fails the built-in catalog is still there.
  if (file.format !== FORMAT) return null
  if (!Array.isArray(file.models) || file.models.length === 0) return null

  log.info(
    'Serving the remembered model list',
    `${file.models.length} models`,
    file.at ? `from ${new Date(file.at).toISOString()}` : 'of unknown age'
  )
  return file.models
}
