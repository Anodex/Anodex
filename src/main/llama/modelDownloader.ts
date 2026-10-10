import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ModelDownloadProgress } from '@shared/model.types'
import {
  recommendedModelFileName,
  recommendedVisionProjectorFileName,
  type RecommendedModel
} from '@shared/recommendedModels'
import { resolveContained } from '../tools/workspace'
import { createLogger } from '../utils/logger'

const log = createLogger('downloader')

/** One in-flight download's abort controller, keyed by `RecommendedModel.id`. */
const activeDownloads = new Map<string, AbortController>()

/** The most often a download reports progress to the window. */
const PROGRESS_INTERVAL_MS = 150

/** Abort an in-progress download, if one is running for this model. No-op otherwise. */
export function cancelDownload(modelId: string): void {
  activeDownloads.get(modelId)?.abort()
}

/** Whether any model is being downloaded right now. */
export function hasActiveDownload(): boolean {
  return activeDownloads.size > 0
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
 * Rejects on a network error, a non-OK response, or cancellation via
 * {@link cancelDownload}. Either way what arrived stays on disk as a `.part`
 * file the next attempt resumes from; {@link discardPartialDownload} is how
 * a person says they do not want it.
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
    let lastReportAt = 0
    const report = (
      active: 'model' | 'projector',
      received: number,
      total: number | null
    ): void => {
      if (active === 'model') currentModelBytes = received
      else currentProjectorBytes = received
      // Every network chunk calls this, hundreds of times a second on a fast
      // line, and each report is an IPC message and a renderer update. That
      // many kept the window busy enough that a click on Cancel queued behind
      // them. A few reports a second draw the same bar; the terminal report
      // below is sent regardless.
      const now = Date.now()
      if (now - lastReportAt < PROGRESS_INTERVAL_MS) return
      lastReportAt = now
      // While the model streams, the projector still to come counts toward the
      // total, so the bar matches the size the card quoted and never shrinks
      // back when the second file starts.
      const pendingProjectorBytes =
        projectorPath && !knownProjectorBytes ? (model.visionProjectorBytes ?? 0) : 0
      const otherKnown =
        active === 'model' ? knownProjectorBytes + pendingProjectorBytes : currentModelBytes
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
      // What a retry would resume from, so the card can offer it.
      receivedBytes: partialDownloadBytes(model, targetDir),
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
 * Bytes already on disk toward `model`: finished files of a two-file download
 * plus any resumable `.part`. Zero when nothing would be resumed — a part with
 * no validator beside it is discarded on the next attempt, so it is not
 * offered as progress.
 */
export function partialDownloadBytes(model: RecommendedModel, targetDir: string): number {
  const finalPath = resolveDownloadTarget(targetDir, recommendedModelFileName(model))
  const projectorName = recommendedVisionProjectorFileName(model)
  const projectorPath = projectorName ? resolveDownloadTarget(targetDir, projectorName) : undefined
  const modelDone = existsSync(finalPath)
  if (modelDone && (!projectorPath || existsSync(projectorPath))) return 0
  const onDisk = (path: string): number =>
    existsSync(path) ? statSync(path).size : resumableBytes(path)
  const bytes = onDisk(finalPath) + (projectorPath ? onDisk(projectorPath) : 0)
  // A finished model with no projector part yet is an installed text model as
  // far as anything else can tell; only call it partial when a part exists.
  return modelDone && projectorPath && !resumableBytes(projectorPath) ? 0 : bytes
}

/**
 * Throw away what a cancelled or failed download left behind. Finished files
 * are left alone: a model whose projector never arrived still works as a text
 * model, and deleting it is what Delete in the model list is for.
 */
export async function discardPartialDownload(
  model: RecommendedModel,
  targetDir: string
): Promise<void> {
  if (activeDownloads.has(model.id)) throw new Error('This model is still downloading.')
  const names = [recommendedModelFileName(model), recommendedVisionProjectorFileName(model)]
  for (const name of names) {
    if (!name) continue
    const partPath = `${resolveDownloadTarget(targetDir, name)}.part`
    await discardPartial(partPath, `${partPath}.etag`)
  }
}

/** The size of `finalPath`'s resumable `.part`, or 0 when there is none to resume. */
function resumableBytes(finalPath: string): number {
  const partPath = `${finalPath}.part`
  if (!existsSync(partPath) || !existsSync(`${partPath}.etag`)) return 0
  return statSync(partPath).size
}

/**
 * Where a downloaded file is allowed to land.
 *
 * This kept its own containment check — a lexical `startsWith` — while the file
 * tools used a guard that also follows symlinks and caps link hops. One rule,
 * two implementations, and the weaker one guarding a filename that arrives from
 * a remote catalogue. It uses the shared guard now, so a link inside the models
 * directory cannot land a download outside it either.
 */
function resolveDownloadTarget(targetDir: string, fileName: string): string {
  const root = resolve(targetDir)
  const target = resolveContained(root, fileName, 'models directory')
  if (target === root) {
    // The shared guard allows the root itself, which is right for a workspace
    // path and wrong for a file to write.
    throw new Error('Refusing to download a model with no file name.')
  }
  return target
}

/**
 * Stream a URL to `finalPath` via a sibling `.part` file, renamed on success,
 * resuming from whatever a previous attempt already wrote
 * — the shared mechanics behind {@link downloadModel}, factored out so
 * `EmbeddingService`'s one-off small-model download doesn't need to fabricate
 * a fake `RecommendedModel` (chat-catalog-shaped: tier, family, quality/speed
 * ranks — none of it meaningful for an embedding model) just to reuse this
 * logic. Keeps what arrived as a resumable `.part` on failure or abort.
 */
export async function downloadFile(
  url: string,
  finalPath: string,
  signal: AbortSignal,
  onProgress: (receivedBytes: number, totalBytes: number | null) => void
): Promise<void> {
  const partPath = `${finalPath}.part`
  const tagPath = `${partPath}.etag`

  // What is already on disk, and the validator that says it is still the same
  // remote file. Without a validator there is no safe resume, so a `.part`
  // with no sidecar is discarded rather than trusted.
  const resumeFrom = existsSync(partPath) && existsSync(tagPath) ? statSync(partPath).size : 0
  const validator = resumeFrom > 0 ? readFileSync(tagPath, 'utf-8').trim() : ''

  // Failed or cancelled, the part file stays. The network dropping at 95% of
  // a thirty-gigabyte model used to mean starting again from zero, and so did
  // pressing Cancel to free the connection for a minute; both now pick up
  // where they stopped, and the card offers to discard the part instead.
  const headers: Record<string, string> = {}
  if (resumeFrom > 0 && validator) {
    headers['range'] = `bytes=${resumeFrom}-`
    // The whole safety of resuming. If the file changed since the part was
    // written, the server ignores the Range and sends 200 with the new
    // file, and the branch below starts over instead of splicing two
    // different downloads into one corrupt GGUF.
    headers['if-range'] = validator
  }

  const response = await fetch(url, { signal, headers })

  // 416 means the part is at or past the end — a previous run that was
  // killed between the last write and the rename, or a truncated remote
  // file. Neither is resumable; start clean.
  if (response.status === 416) {
    await discardPartial(partPath, tagPath)
    return downloadFile(url, finalPath, signal, onProgress)
  }
  if (!response.ok || !response.body) {
    // A resource that is gone stays gone, so anything already on disk for
    // it can never be finished and would sit there unreachable — the app
    // shows no partials, so nobody would ever find it to delete. A 5xx or a
    // dropped socket is the opposite: exactly what resuming is for.
    if (response.status === 404 || response.status === 410) {
      await discardPartial(partPath, tagPath)
    }
    throw new Error(`Download failed: HTTP ${response.status}`)
  }

  const resumed = response.status === 206 && resumeFrom > 0
  if (!resumed && resumeFrom > 0) {
    // Server ignored the Range, or the validator no longer matches. Either
    // way the bytes on disk are not a prefix of what is arriving.
    log.info('Resume refused by the server; starting this download again', finalPath)
    await discardPartial(partPath, tagPath)
  }

  // On a 206 the content-length is what is *left*, not the file. Reporting
  // it as the total made a resumed 30GB download claim it was 2GB and
  // finish at 700%.
  const totalBytes = totalFromHeaders(response.headers, resumed ? resumeFrom : 0)

  // Recorded before any bytes land, so an interrupted run can resume from
  // whatever did.
  const nextValidator = response.headers.get('etag') ?? response.headers.get('last-modified')
  if (nextValidator) writeFileSync(tagPath, nextValidator, 'utf-8')
  else await rm(tagPath, { force: true }).catch(() => {})

  let receivedBytes = resumed ? resumeFrom : 0
  if (resumed) onProgress(receivedBytes, totalBytes)

  const readable = Readable.fromWeb(response.body)
  readable.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length
    onProgress(receivedBytes, totalBytes)
  })

  await pipeline(readable, createWriteStream(partPath, resumed ? { flags: 'a' } : {}))
  await rename(partPath, finalPath)
  await rm(tagPath, { force: true }).catch(() => {})
}

/** Remove a partial download and the validator that described it. */
async function discardPartial(partPath: string, tagPath: string): Promise<void> {
  await rm(partPath, { force: true }).catch(() => {})
  await rm(tagPath, { force: true }).catch(() => {})
}

/**
 * The size of the whole file, not of this response.
 *
 * A 206 carries `Content-Range: bytes 1000-1999/30000`, where the part after
 * the slash is the only honest total. `content-length` on that same response
 * is 1000. Falls back to content-length plus what is already on disk, which is
 * right for a 200 and a reasonable guess for a 206 with no content-range.
 */
export function totalFromHeaders(headers: Headers, alreadyOnDisk: number): number | null {
  const range = headers.get('content-range')
  const slash = range?.lastIndexOf('/')
  if (range && slash !== undefined && slash > -1) {
    const total = Number(range.slice(slash + 1))
    if (Number.isFinite(total) && total > 0) return total
  }
  const length = Number(headers.get('content-length'))
  if (!Number.isFinite(length) || length <= 0) return null
  return length + alreadyOnDisk
}
