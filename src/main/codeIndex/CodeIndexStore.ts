import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { CodeIndexFile } from '@shared/codeIndex.types'
import { createLogger } from '../utils/logger'
import { writeJsonAtomic } from '../utils/atomicWrite'

const log = createLogger('code-index-store')

const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]+$/

/**
 * Persists one project's semantic code index at
 * `userData/projects/<id>/code-index.json` — a sibling of
 * `ProjectMemoryStore`'s own per-project file, same directory convention.
 * `CodeIndexer` owns all the actual walking/chunking/embedding/search logic;
 * this store is purely the read/write layer, matching the Store+Service split
 * used everywhere else in this codebase (`SchedulerStore`/`SchedulerService`,
 * `AgentRunStore`/`AgentRunService`).
 */
class CodeIndexStore {
  private dir = ''
  private cache = new Map<string, CodeIndexFile>()

  /** Must be called after `app.whenReady()`. */
  init(): void {
    this.dir = join(app.getPath('userData'), 'projects')
    log.info('Initialised at', this.dir)
  }

  /** Returns `undefined` when this project has never been indexed. */
  get(projectId: string): CodeIndexFile | undefined {
    assertSafeProjectId(projectId)
    const cached = this.cache.get(projectId)
    if (cached) return cached

    const file = this.filePath(projectId)
    if (!existsSync(file)) return undefined
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as CodeIndexFile
      this.cache.set(projectId, raw)
      return raw
    } catch (error) {
      log.warn('Failed to parse code index, treating as missing:', error)
      return undefined
    }
  }

  save(projectId: string, index: CodeIndexFile): void {
    assertSafeProjectId(projectId)
    try {
      const dir = join(this.dir, projectId)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeJsonAtomic(this.filePath(projectId), index)
    } catch (error) {
      log.error('Failed to persist code index:', error)
      return
    }
    this.cache.set(projectId, index)
  }

  private filePath(projectId: string): string {
    return join(this.dir, projectId, 'code-index.json')
  }
}

function assertSafeProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || !SAFE_PROJECT_ID.test(projectId)) {
    throw new Error(`Unsafe project id: "${projectId}"`)
  }
}

export const codeIndexStore = new CodeIndexStore()
