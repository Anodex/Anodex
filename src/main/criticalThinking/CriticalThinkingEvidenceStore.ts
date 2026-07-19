import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
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

  record(runId: string, artifact: ToolArtifact): void {
    const artifacts = this.list(runId)
    if (artifacts.some((item) => item.id === artifact.id)) return
    artifacts.push(artifact)
    this.cache.set(runId, artifacts)
    this.enqueuePersist(runId, artifacts)
  }

  delete(runId: string): void {
    this.cache.delete(runId)
    this.writeQueue = this.writeQueue
      .then(() => rm(this.pathFor(runId), { force: true }))
      .catch((error: unknown) => log.error('Failed to delete evidence:', runId, error))
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private load(runId: string): ToolArtifact[] {
    const path = this.pathFor(runId)
    if (!existsSync(path)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return Array.isArray(parsed) ? (parsed as ToolArtifact[]) : []
    } catch (error) {
      log.warn('Failed to read evidence sidecar:', runId, error)
      return []
    }
  }

  private enqueuePersist(runId: string, artifacts: ToolArtifact[]): void {
    const snapshot = JSON.stringify(artifacts, null, 2)
    this.writeQueue = this.writeQueue
      .then(async () => {
        const path = this.pathFor(runId)
        const temporaryPath = `${path}.${process.pid}.tmp`
        await writeFile(temporaryPath, snapshot, 'utf8')
        await rename(temporaryPath, path)
      })
      .catch((error: unknown) => log.error('Failed to persist evidence:', runId, error))
  }

  private pathFor(runId: string): string {
    if (!this.directory) throw new Error('CriticalThinkingEvidenceStore is not initialised.')
    if (!/^critical_[a-z0-9_]+$/i.test(runId)) throw new Error('Invalid Critical Thinking run id.')
    return join(this.directory, `${runId}.json`)
  }
}

export const criticalThinkingEvidenceStore = new CriticalThinkingEvidenceStore()
