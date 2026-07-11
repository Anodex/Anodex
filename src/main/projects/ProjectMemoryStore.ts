import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import type {
  FileTouch,
  FileTouchAction,
  ProjectMemory,
  ProjectRecallEvent,
  VerificationResult
} from '@shared/projectMemory.types'
import { createLogger } from '../utils/logger'
import { writeJsonAtomic } from '../utils/atomicWrite'

const log = createLogger('project-memory')

const MAX_FILES_TOUCHED = 60
const MAX_EVENTS = 10
const MAX_ASSISTANT_SUMMARY_CHARS = 220
const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]+$/
const FILE_TOUCH_ACTIONS = new Set<FileTouchAction>(['read', 'write', 'delete', 'move'])
/** Bumped only if the persisted shape changes in a way old readers can't tolerate. */
const STORE_VERSION = 1

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
    assertSafeProjectId(projectId)
    const current = this.load(projectId)
    const next: ProjectMemory = {
      ...current,
      filesTouched: [
        { path, action, at: Date.now() },
        ...current.filesTouched.filter((touch) => touch.path !== path)
      ].slice(0, MAX_FILES_TOUCHED)
    }
    this.persist(next)
  }

  /**
   * Record one completed coding turn as a structured event — see
   * `ProjectRecallEvent`'s doc comment for why this replaced a raw assistant-
   * prose summary. Skipped entirely if the turn produced nothing worth
   * recalling (no file changes, no tool outcomes, no verification, no
   * supplemental summary), same as the old summary-only guard.
   */
  recordEvent(projectId: string, event: Omit<ProjectRecallEvent, 'createdAt'>): void {
    assertSafeProjectId(projectId)
    const assistantSummary = event.assistantSummary
      ? capAssistantSummary(cleanSummaryText(event.assistantSummary))
      : undefined
    const isEmpty =
      event.changedFiles.length === 0 &&
      event.successfulTools.length === 0 &&
      event.failedTools.length === 0 &&
      event.verification.length === 0 &&
      !assistantSummary
    if (isEmpty) return

    const current = this.load(projectId)
    const recorded: ProjectRecallEvent = { ...event, assistantSummary, createdAt: Date.now() }
    const next: ProjectMemory = {
      ...current,
      recentEvents: [recorded, ...current.recentEvents].slice(0, MAX_EVENTS)
    }
    this.persist(next)
  }

  get(projectId: string): ProjectMemory {
    assertSafeProjectId(projectId)
    return this.load(projectId)
  }

  /** Remove a project's memory entirely (called when the project itself is deleted). */
  delete(projectId: string): void {
    assertSafeProjectId(projectId)
    this.cache.delete(projectId)
    try {
      rmSync(join(this.dir, projectId), { recursive: true, force: true })
    } catch (error) {
      log.warn('Failed to delete project memory:', error)
    }
  }

  private load(projectId: string): ProjectMemory {
    assertSafeProjectId(projectId)
    const cached = this.cache.get(projectId)
    if (cached) return cached

    const file = this.filePath(projectId)
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown
        // A pre-existing file from before this store recorded structured
        // events (only ever `recentSummaries`) has nothing usable there —
        // it's a small, disposable activity ledger, not durable user data,
        // so starting the event list fresh rather than migrating is fine.
        // Malformed individual entries are dropped, not treated as a reason
        // to discard the whole file (see `validateProjectMemoryFile`).
        const memory: ProjectMemory = { projectId, ...validateProjectMemoryFile(raw) }
        this.cache.set(projectId, memory)
        return memory
      } catch (error) {
        log.warn('Failed to parse project memory, starting fresh:', error)
      }
    }

    const empty: ProjectMemory = { projectId, filesTouched: [], recentEvents: [] }
    this.cache.set(projectId, empty)
    return empty
  }

  /**
   * Writes to disk first and only swaps the cache to `memory` once that
   * succeeds — `recordTouch`/`recordEvent` build `memory` as a fresh object
   * (not a mutation of the currently-cached one) precisely so a failed write
   * leaves the cache holding the last known-good state instead of a change
   * that only exists in memory. Kept best-effort (logged, not rethrown): this
   * ledger is a side channel alongside the real tool action (e.g. a file
   * write) that already succeeded by the time this runs, so a write failure
   * here shouldn't turn a genuinely successful tool call into a reported error.
   */
  private persist(memory: ProjectMemory): void {
    try {
      const dir = join(this.dir, memory.projectId)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeJsonAtomic(join(dir, 'memory.json'), { version: STORE_VERSION, ...memory })
    } catch (error) {
      log.error('Failed to persist project memory:', error)
      return
    }
    this.cache.set(memory.projectId, memory)
  }

  private filePath(projectId: string): string {
    assertSafeProjectId(projectId)
    return join(this.dir, projectId, 'memory.json')
  }
}

function assertSafeProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || !SAFE_PROJECT_ID.test(projectId)) {
    throw new Error(`Unsafe project id: "${projectId}"`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidFileTouch(value: unknown): value is FileTouch {
  return (
    isPlainObject(value) &&
    typeof value.path === 'string' &&
    FILE_TOUCH_ACTIONS.has(value.action as FileTouchAction) &&
    typeof value.at === 'number'
  )
}

function isValidVerificationResult(value: unknown): value is VerificationResult {
  return (
    isPlainObject(value) &&
    typeof value.command === 'string' &&
    (value.status === 'passed' || value.status === 'failed')
  )
}

function isValidRecallEvent(value: unknown): value is ProjectRecallEvent {
  return (
    isPlainObject(value) &&
    typeof value.conversationId === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.createdAt === 'number' &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every((f) => typeof f === 'string') &&
    Array.isArray(value.successfulTools) &&
    value.successfulTools.every((t) => typeof t === 'string') &&
    Array.isArray(value.failedTools) &&
    value.failedTools.every((t) => typeof t === 'string') &&
    Array.isArray(value.verification) &&
    value.verification.every(isValidVerificationResult) &&
    (value.assistantSummary === undefined || typeof value.assistantSummary === 'string')
  )
}

/**
 * Defensive parse of a loaded project-memory file: never throws, never
 * trusts disk content blindly. A file with some malformed entries loses
 * only those entries, not the whole ledger. Exported for unit testing.
 */
export function validateProjectMemoryFile(
  raw: unknown
): Pick<ProjectMemory, 'filesTouched' | 'recentEvents'> {
  if (!isPlainObject(raw)) return { filesTouched: [], recentEvents: [] }
  const filesTouched = Array.isArray(raw.filesTouched)
    ? raw.filesTouched.filter(isValidFileTouch)
    : []
  const recentEvents = Array.isArray(raw.recentEvents)
    ? raw.recentEvents.filter(isValidRecallEvent)
    : []
  return { filesTouched, recentEvents }
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

/** Caps the (already-cleaned) supplemental assistant summary to a short excerpt. Exported for unit testing. */
export function capAssistantSummary(cleaned: string): string | undefined {
  if (!cleaned) return undefined
  return cleaned.length > MAX_ASSISTANT_SUMMARY_CHARS
    ? `${cleaned.slice(0, MAX_ASSISTANT_SUMMARY_CHARS)}…`
    : cleaned
}

export const projectMemoryStore = new ProjectMemoryStore()
