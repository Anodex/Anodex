import { createWriteStream, existsSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ModelDownloadProgress } from '@shared/model.types'
import { recommendedModelFileName, type RecommendedModel } from '@shared/recommendedModels'
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
 * Resolves to the final file path on success. Rejects (and cleans up the
 * partial file) on a network error, a non-OK response, or cancellation via
 * {@link cancelDownload}.
 */
export async function downloadModel(
  model: RecommendedModel,
  targetDir: string,
  onProgress: (progress: ModelDownloadProgress) => void
): Promise<string> {
  const finalPath = join(targetDir, recommendedModelFileName(model))

  if (existsSync(finalPath)) {
    const sizeBytes = statSync(finalPath).size
    onProgress({
      modelId: model.id,
      receivedBytes: sizeBytes,
      totalBytes: sizeBytes,
      status: 'done'
    })
    return finalPath
  }

  if (activeDownloads.has(model.id)) {
    throw new Error('This model is already downloading.')
  }

  const controller = new AbortController()
  activeDownloads.set(model.id, controller)
  try {
    await downloadFile(
      model.downloadUrl,
      finalPath,
      controller.signal,
      (receivedBytes, totalBytes) =>
        onProgress({ modelId: model.id, receivedBytes, totalBytes, status: 'downloading' })
    )
    const sizeBytes = statSync(finalPath).size
    onProgress({
      modelId: model.id,
      receivedBytes: sizeBytes,
      totalBytes: sizeBytes,
      status: 'done'
    })
    return finalPath
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
