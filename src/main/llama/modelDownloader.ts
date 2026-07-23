import { createWriteStream, existsSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ModelDownloadProgress } from '@shared/model.types'
import {
  recommendedModelFileName,
  recommendedVisionProjectorFileName,
  type RecommendedModel
} from '@shared/recommendedModels'
import { createLogger } from '../utils/logger'

const log = createLogger('downloader')

/** One in-flight download's abort controller, keyed by `RecommendedModel.id`. */
const activeDownloads = new Map<string, AbortController>()

/** Abort an in-progress download, if one is running for this model. No-op otherwise. */
export function cancelDownload(modelId: string): void {
  activeDownloads.get(modelId)?.abort()
}

/** Abort every in-progress download — called on app quit. */
export function cancelAllDownloads(): void {
  for (const controller of activeDownloads.values()) controller.abort()
  activeDownloads.clear()
}

/**
 * Download a recommended model's GGUF into `targetDir`, reporting progress as
 * bytes arrive. If a file with the expected name already exists there, the
 * download is skipped and its path is returned immediately — recommended
 * models are matched by filename, so this also naturally dedupes a model the
 * user already has.
 *
 * Resolves to the main model path and optional projector path on success.
 * Rejects (and cleans up the active partial file) on a network error, a
 * non-OK response, or cancellation via {@link cancelDownload}.
 */
export async function downloadModel(
  model: RecommendedModel,
  targetDir: string,
  onProgress: (progress: ModelDownloadProgress) => void
): Promise<{ modelPath: string; visionProjectorPath?: string }> {
  const finalPath = resolveDownloadTarget(targetDir, recommendedModelFileName(model))
  const projectorName = recommendedVisionProjectorFileName(model)
  const projectorPath = projectorName ? resolveDownloadTarget(targetDir, projectorName) : undefined

  if (existsSync(finalPath) && (!projectorPath || existsSync(projectorPath))) {
    const sizeBytes =
      statSync(finalPath).size +
      (projectorPath && existsSync(projectorPath) ? statSync(projectorPath).size : 0)
    onProgress({
      modelId: model.id,
      receivedBytes: sizeBytes,
      totalBytes: sizeBytes,
      status: 'done'
    })
    return { modelPath: finalPath, visionProjectorPath: projectorPath }
  }

  if (activeDownloads.has(model.id)) {
    throw new Error('This model is already downloading.')
  }

  const controller = new AbortController()
  activeDownloads.set(model.id, controller)
  try {
    const knownModelBytes = existsSync(finalPath) ? statSync(finalPath).size : 0
    const knownProjectorBytes =
      projectorPath && existsSync(projectorPath) ? statSync(projectorPath).size : 0
    let currentModelBytes = knownModelBytes
    let currentProjectorBytes = knownProjectorBytes
    const report = (
      active: 'model' | 'projector',
      received: number,
      total: number | null
    ): void => {
      if (active === 'model') currentModelBytes = received
      else currentProjectorBytes = received
      const otherKnown = active === 'model' ? knownProjectorBytes : currentModelBytes
      onProgress({
        modelId: model.id,
        receivedBytes: currentModelBytes + currentProjectorBytes,
        totalBytes: total === null ? null : total + otherKnown,
        status: 'downloading'
      })
    }

    if (!existsSync(finalPath)) {
      await downloadFile(model.downloadUrl, finalPath, controller.signal, (received, total) =>
        report('model', received, total)
      )
      currentModelBytes = statSync(finalPath).size
    }

    if (model.visionProjectorUrl && projectorPath && !existsSync(projectorPath)) {
      await downloadFile(
        model.visionProjectorUrl,
        projectorPath,
        controller.signal,
        (received, total) => report('projector', received, total)
      )
      currentProjectorBytes = statSync(projectorPath).size
    }
    const sizeBytes = currentModelBytes + currentProjectorBytes
    onProgress({
      modelId: model.id,
      receivedBytes: sizeBytes,
      totalBytes: sizeBytes,
      status: 'done'
    })
    return { modelPath: finalPath, visionProjectorPath: projectorPath }
  } catch (error) {
    const canceled = controller.signal.aborted
    if (!canceled) log.warn('Model download failed', model.id, error)
    onProgress({
      modelId: model.id,
      receivedBytes: 0,
      totalBytes: null,
      status: canceled ? 'canceled' : 'error',
      error: canceled ? undefined : error instanceof Error ? error.message : String(error)
    })
    throw error
  } finally {
    activeDownloads.delete(model.id)
  }
}

function resolveDownloadTarget(targetDir: string, fileName: string): string {
  const root = resolve(targetDir)
  const target = resolve(root, fileName)
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error('Refusing to download a model outside the configured models directory.')
  }
  return target
}

/**
 * Stream a URL to `finalPath` via a sibling `.part` file, renamed on success
 * — the shared mechanics behind {@link downloadModel}, factored out so
 * `EmbeddingService`'s one-off small-model download doesn't need to fabricate
 * a fake `RecommendedModel` (chat-catalog-shaped: tier, family, quality/speed
 * ranks — none of it meaningful for an embedding model) just to reuse this
 * logic. Leaves no partial file behind on failure or abort.
 */
export async function downloadFile(
  url: string,
  finalPath: string,
  signal: AbortSignal,
  onProgress: (receivedBytes: number, totalBytes: number | null) => void
): Promise<void> {
  const partPath = `${finalPath}.part`
  try {
    const response = await fetch(url, { signal })
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status}`)
    }

    const totalBytes = Number(response.headers.get('content-length')) || null
    let receivedBytes = 0

    const readable = Readable.fromWeb(response.body)
    readable.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length
      onProgress(receivedBytes, totalBytes)
    })

    await pipeline(readable, createWriteStream(partPath))
    await rename(partPath, finalPath)
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => {})
    throw error
  }
}
