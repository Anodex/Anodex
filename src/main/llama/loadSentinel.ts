/**
 * Crash sentinel for model loading.
 *
 * A file is written immediately before the native engine is handed a model and
 * removed the instant it returns — success or caught failure alike. A caught
 * failure is not what this guards against: that path already reports a real
 * error to the user. What it guards against is the process simply ceasing to
 * exist mid-load, which is what a GPU-backend crash inside llama.cpp looks
 * like from JavaScript. Nothing runs after it, so the only way to know it
 * happened is to have written the record beforehand.
 *
 * **Writes are synchronous, deliberately** — the same reasoning as
 * `diagnostics/logFile.ts`, and for a sharper reason: an async write has no
 * chance to flush when the very next native call kills the process. Two short
 * synchronous file operations per model load is nothing; a model load already
 * costs seconds of disk I/O.
 *
 * The record is read and consumed once at startup, so a crash during the
 * *recovery* attempt writes a fresh one rather than compounding with the old.
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { InterruptedModelLoad, ModelLoadRecovery } from '@shared/model.types'
import { recoveryFor } from './modelLoadRecovery'
import { createLogger } from '../utils/logger'

const log = createLogger('model-sentinel')

const FILE_NAME = 'model-load.json'

let sentinelPath: string | null = null
let pendingRecovery: ModelLoadRecovery | null = null

function isInterruptedLoad(value: unknown): value is InterruptedModelLoad {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.modelPath === 'string' &&
    typeof record.modelName === 'string' &&
    (typeof record.gpuLayers === 'number' || record.gpuLayers === 'auto') &&
    (record.contextSize === undefined || typeof record.contextSize === 'number') &&
    typeof record.vision === 'boolean' &&
    typeof record.startedAt === 'string'
  )
}

function remove(): void {
  if (!sentinelPath) return
  try {
    fs.rmSync(sentinelPath, { force: true })
  } catch (error) {
    log.warn('Could not clear the model-load sentinel:', error)
  }
}

/**
 * Read and consume any sentinel left by the previous run. Call once at
 * startup, before anything can load a model.
 */
export function initLoadSentinel(): void {
  try {
    sentinelPath = path.join(app.getPath('userData'), FILE_NAME)
  } catch (error) {
    log.warn('Could not resolve the sentinel path; crash recovery is off:', error)
    return
  }

  let raw: string
  try {
    raw = fs.readFileSync(sentinelPath, 'utf8')
  } catch {
    // Overwhelmingly the normal case: the last run shut down cleanly.
    return
  }

  // Consume it first. Whatever the contents turn out to be, leaving the file
  // in place would re-report the same crash on every future launch.
  remove()

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isInterruptedLoad(parsed)) {
      log.warn('Discarding a malformed model-load sentinel.')
      return
    }
    pendingRecovery = recoveryFor(parsed)
    log.warn('Previous run stopped while loading', parsed.modelName)
  } catch (error) {
    log.warn('Could not parse the model-load sentinel:', error)
  }
}

/** Record that a load is starting. Paired with {@link finishModelLoad}. */
export function beginModelLoad(load: InterruptedModelLoad): void {
  if (!sentinelPath) return
  try {
    fs.writeFileSync(sentinelPath, JSON.stringify(load), 'utf8')
  } catch (error) {
    // Non-fatal — losing crash recovery is much better than blocking the load.
    log.warn('Could not write the model-load sentinel:', error)
  }
}

/**
 * Record that a load finished, however it finished. Safe to call when no load
 * is in flight, which is what makes it usable from the quit handler.
 */
export function finishModelLoad(): void {
  remove()
}

/** The previous run's interrupted load, if there was one. */
export function getLoadRecovery(): ModelLoadRecovery | null {
  return pendingRecovery
}

/** Forget the pending recovery once the user has answered it. */
export function clearLoadRecovery(): void {
  pendingRecovery = null
}
