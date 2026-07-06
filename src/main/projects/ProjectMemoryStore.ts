import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { FileTouchAction, ProjectMemory, TaskSummary } from '@shared/projectMemory.types'
import { createLogger } from '../utils/logger'

const log = createLogger('project-memory')

const MAX_FILES_TOUCHED = 60
const MAX_SUMMARIES = 10
const MAX_SUMMARY_CHARS = 220

/**
 * Persists a small per-project activity ledger — recently touched files and
 * recent task summaries — in `userData/projects/<projectId>/memory.json`.
 *
 * This is what lets the assistant "remember" what it already inspected or
 * changed in a project across separate conversations, not just within one.
 * Kept deliberately tiny (capped lists) so it stays cheap to read on every
 * generation and never dominates the system prompt.
 */
class ProjectMemoryStore {
  private dir = ''
  private cache = new Map<string, ProjectMemory>()

  /** Must be called after `app.whenReady()`. */
  init(): void {
    this.dir = join(app.getPath('userData'), 'projects')
    log.info('Initialised at', this.dir)
  }

  recordTouch(projectId: string, path: string, action: FileTouchAction): void {
    const memory = this.load(projectId)
    memory.filesTouched = [
      { path, action, at: Date.now() },
      ...memory.filesTouched.filter((touch) => touch.path !== path)
    ].slice(0, MAX_FILES_TOUCHED)
    this.persist(memory)
  }

  recordSummary(projectId: string, conversationId: string, summary: string): void {
    const cleaned = cleanSummaryText(summary)
    if (!cleaned) return
    const memory = this.load(projectId)
    const capped: TaskSummary = {
      conversationId,
      summary:
        cleaned.length > MAX_SUMMARY_CHARS ? `${cleaned.slice(0, MAX_SUMMARY_CHARS)}…` : cleaned,
      at: Date.now()
    }
    memory.recentSummaries = [capped, ...memory.recentSummaries].slice(0, MAX_SUMMARIES)
    this.persist(memory)
  }

  get(projectId: string): ProjectMemory {
    return this.load(projectId)
  }

  /** Remove a project's memory entirely (called when the project itself is deleted). */
  delete(projectId: string): void {
    this.cache.delete(projectId)
    try {
      rmSync(join(this.dir, projectId), { recursive: true, force: true })
    } catch (error) {
      log.warn('Failed to delete project memory:', error)
    }
  }

  private load(projectId: string): ProjectMemory {
    const cached = this.cache.get(projectId)
    if (cached) return cached

    const file = this.filePath(projectId)
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf-8')) as ProjectMemory
        const memory: ProjectMemory = {
          projectId,
          filesTouched: raw.filesTouched ?? [],
          recentSummaries: raw.recentSummaries ?? []
        }
        this.cache.set(projectId, memory)
        return memory
      } catch (error) {
        log.warn('Failed to parse project memory, starting fresh:', error)
      }
    }

    const empty: ProjectMemory = { projectId, filesTouched: [], recentSummaries: [] }
    this.cache.set(projectId, empty)
    return empty
  }

  private persist(memory: ProjectMemory): void {
    this.cache.set(memory.projectId, memory)
    try {
      const dir = join(this.dir, memory.projectId)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'memory.json'), JSON.stringify(memory, null, 2), 'utf-8')
    } catch (error) {
      log.error('Failed to persist project memory:', error)
    }
  }

  private filePath(projectId: string): string {
    return join(this.dir, projectId, 'memory.json')
  }
}

/**
 * Strip fenced code blocks and `<tool_call>` tags before a reply is stored as a
 * task summary. Without this, a leftover unexecuted tool-call attempt (see
 * `toolCallFallback.ts`) or a code snippet ends up saved verbatim — noisy, and
 * liable to bias a later unrelated task into pattern-matching against it (a
 * "fix the add() function" summary primed a later, unrelated file-fix request).
 * Exported for unit testing.
 */
export function cleanSummaryText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const projectMemoryStore = new ProjectMemoryStore()
