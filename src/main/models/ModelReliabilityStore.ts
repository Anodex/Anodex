import { app } from 'electron'
import { writeJsonAtomic } from '../utils/atomicWrite'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import { createLogger } from '../utils/logger'

const log = createLogger('model-reliability')

/** A tool outcome worth recording. `denied` is intentionally excluded — see the shared type's doc comment. */
export type RecordableToolStatus = 'success' | 'error'

/**
 * Persists per-model, per-tool usage reliability in its own
 * `userData/model-reliability/models.json` — a sibling of `conversations/`
 * and `projects/`, not loose in the `userData` root, and not inside the
 * user-configurable models *directory* (that holds the actual `.gguf` files
 * and can point anywhere; this data must always live in a stable,
 * Anodex-owned location regardless of where models are stored).
 */
class ModelReliabilityStore {
  private filePath = ''
  private cache = new Map<string, ModelReliabilityRecord>()

  /** Must be called after `app.whenReady()`. */
  init(): void {
    const dir = join(app.getPath('userData'), 'model-reliability')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, 'models.json')
    this.migrateLegacyFile()
    this.cache = this.load()
    log.info('Initialised at', this.filePath)
  }

  /** One-time migration from the original flat `userData/modelReliability.json` location. */
  private migrateLegacyFile(): void {
    const legacyPath = join(app.getPath('userData'), 'modelReliability.json')
    if (existsSync(this.filePath) || !existsSync(legacyPath)) return
    try {
      renameSync(legacyPath, this.filePath)
      log.info('Migrated legacy reliability data from', legacyPath)
    } catch (error) {
      log.warn('Failed to migrate legacy reliability data:', error)
    }
  }

  recordToolCall(
    modelId: string,
    modelName: string,
    toolName: string,
    status: RecordableToolStatus,
    fileName?: string
  ): void {
    const record = this.getOrCreate(modelId, modelName)
    const stats = record.byTool[toolName] ?? { successes: 0, errors: 0 }
    if (status === 'success') stats.successes += 1
    else stats.errors += 1
    record.byTool[toolName] = stats
    record.modelName = modelName
    if (fileName) record.fileName = fileName
    record.lastUsedAt = Date.now()
    this.persist()
  }

  recordFabrication(modelId: string, modelName: string, fileName?: string): void {
    const record = this.getOrCreate(modelId, modelName)
    record.fabrications += 1
    record.modelName = modelName
    if (fileName) record.fileName = fileName
    record.lastUsedAt = Date.now()
    this.persist()
  }

  get(modelId: string): ModelReliabilityRecord | undefined {
    return this.cache.get(modelId)
  }

  getAll(): ModelReliabilityRecord[] {
    return [...this.cache.values()]
  }

  private getOrCreate(modelId: string, modelName: string): ModelReliabilityRecord {
    const existing = this.cache.get(modelId)
    if (existing) return existing
    const created: ModelReliabilityRecord = {
      modelId,
      modelName,
      byTool: {},
      fabrications: 0,
      lastUsedAt: Date.now()
    }
    this.cache.set(modelId, created)
    return created
  }

  private load(): Map<string, ModelReliabilityRecord> {
    if (!existsSync(this.filePath)) return new Map()
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as ModelReliabilityRecord[]
      return new Map(raw.map((record) => [record.modelId, record]))
    } catch (error) {
      log.warn('Failed to parse model reliability data, starting fresh:', error)
      return new Map()
    }
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.filePath, this.getAll())
    } catch (error) {
      log.error('Failed to persist model reliability data:', error)
    }
  }
}

export const modelReliabilityStore = new ModelReliabilityStore()
