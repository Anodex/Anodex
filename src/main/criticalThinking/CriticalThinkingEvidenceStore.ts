import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { writeJsonAtomicAsync } from '../utils/atomicWrite'
import { join } from 'node:path'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { createLogger } from '../utils/logger'

const log = createLogger('critical-thinking-evidence')

/**
 * Sidecar persistence for full research artifacts. Runs keep only compact source
 * metadata in runs.json, preventing large fetched passages from blocking the
 * main process on every progress update.
 */
export class CriticalThinkingEvidenceStore {
  private directory = ''
  private readonly cache = new Map<string, ToolArtifact[]>()
  private writeQueue = Promise.resolve()
  private readonly pendingWrites = new Map<string, ToolArtifact[] | null>()
  private writerRunning = false
  private lastWriteError: unknown = null

  init(directory = join(app.getPath('userData'), 'critical-thinking', 'evidence')): void {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    this.directory = directory
    log.info('Initialised at', directory)
  }

  list(runId: string): ToolArtifact[] {
    const cached = this.cache.get(runId)
    if (cached) return [...cached]
    const loaded = this.load(runId)
    this.cache.set(runId, loaded)
    return [...loaded]
  }

  /** Persist a new artifact and report whether it was inserted. */
  record(runId: string, artifact: ToolArtifact): boolean {
    const artifacts = this.list(runId)
    if (artifacts.some((item) => item.id === artifact.id)) return false
    artifacts.push(artifact)
    this.cache.set(runId, artifacts)
    this.enqueuePersist(runId, artifacts)
    return true
  }

  delete(runId: string): void {
    // Keep an empty cache entry while the queued disk removal is pending. A
    // new run can start immediately after plan approval; deleting the cache
    // here would let list() reload the stale sidecar before rm executes.
    this.cache.set(runId, [])
    this.pendingWrites.set(runId, null)
    if (!this.writerRunning) this.startWriter()
  }

  async flush(): Promise<void> {
    while (this.pendingWrites.size > 0 || this.writerRunning) {
      if (this.pendingWrites.size > 0 && !this.writerRunning) this.startWriter()
      const activeWriter = this.writeQueue
      await activeWriter
      if (this.lastWriteError) throw persistenceError(this.lastWriteError)
    }

    if (this.lastWriteError) throw persistenceError(this.lastWriteError)
  }

  private load(runId: string): ToolArtifact[] {
    const path = this.pathFor(runId)
    if (!existsSync(path)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(parsed)) return []
      const artifacts = parsed.filter(isToolArtifact)
      if (artifacts.length !== parsed.length) {
        log.warn('Ignored malformed evidence artifacts:', runId, parsed.length - artifacts.length)
      }
      return artifacts
    } catch (error) {
      log.warn('Failed to read evidence sidecar:', runId, error)
      return []
    }
  }

  private enqueuePersist(runId: string, artifacts: ToolArtifact[]): void {
    this.pendingWrites.set(runId, artifacts)
    if (!this.writerRunning) this.startWriter()
  }

  private startWriter(): void {
    this.writerRunning = true
    this.writeQueue = Promise.resolve().then(() => this.drainWrites())
  }

  private async drainWrites(): Promise<void> {
    try {
      while (this.pendingWrites.size > 0) {
        const entries = [...this.pendingWrites.entries()]
        this.pendingWrites.clear()
        for (let index = 0; index < entries.length; index += 1) {
          const [runId, artifacts] = entries[index]
          try {
            const path = this.pathFor(runId)
            if (artifacts === null) {
              await rm(path, { force: true })
            } else {
              await writeJsonAtomicAsync(path, artifacts)
            }
            this.lastWriteError = null
          } catch (error) {
            this.lastWriteError = error
            // The batch was removed from pendingWrites before I/O began. Restore
            // both the failed operation and every not-yet-attempted operation,
            // while preserving any newer operation queued for the same run.
            for (const [pendingRunId, pendingArtifacts] of entries.slice(index)) {
              if (!this.pendingWrites.has(pendingRunId)) {
                this.pendingWrites.set(pendingRunId, pendingArtifacts)
              }
            }
            log.error('Failed to persist evidence:', runId, error)
            return
          }
        }
      }
    } finally {
      this.writerRunning = false
    }
  }

  private pathFor(runId: string): string {
    if (!this.directory) throw new Error('CriticalThinkingEvidenceStore is not initialised.')
    if (!/^critical_[a-z0-9_]+$/i.test(runId)) throw new Error('Invalid Critical Thinking run id.')
    return join(this.directory, `${runId}.json`)
  }
}

function persistenceError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Failed to persist Critical Thinking evidence.', { cause: error })
}

function isToolArtifact(value: unknown): value is ToolArtifact {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== 'string' ||
    typeof value.conversationId !== 'string' ||
    typeof value.messageId !== 'string' ||
    typeof value.createdAt !== 'number' ||
    (value.research !== undefined &&
      (!isRecord(value.research) ||
        typeof value.research.stepId !== 'string' ||
        typeof value.research.roundId !== 'string'))
  ) {
    return false
  }
  if (value.kind === 'web-search') {
    return (
      typeof value.query === 'string' &&
      typeof value.provider === 'string' &&
      Array.isArray(value.results) &&
      value.results.every(
        (result) =>
          isRecord(result) &&
          typeof result.title === 'string' &&
          typeof result.url === 'string' &&
          typeof result.snippet === 'string' &&
          typeof result.rank === 'number'
      )
    )
  }
  return (
    value.kind === 'web-fetch' &&
    typeof value.requestedUrl === 'string' &&
    typeof value.finalUrl === 'string' &&
    typeof value.status === 'number' &&
    typeof value.contentType === 'string' &&
    typeof value.title === 'string' &&
    typeof value.contentHash === 'string' &&
    typeof value.contentChars === 'number' &&
    typeof value.truncated === 'boolean' &&
    Array.isArray(value.passages) &&
    value.passages.every(
      (passage) =>
        isRecord(passage) &&
        typeof passage.id === 'string' &&
        typeof passage.text === 'string' &&
        typeof passage.score === 'number'
    ) &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export const criticalThinkingEvidenceStore = new CriticalThinkingEvidenceStore()
