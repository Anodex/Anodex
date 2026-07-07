import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Conversation, ConversationState } from '@shared/conversation.types'
import { createLogger } from '../utils/logger'

const log = createLogger('conversations')

const STATE_FILE = 'state.json'
const GENERAL_DIR = 'general'
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** A cached conversation together with the file that backs it. */
interface CacheEntry {
  conversation: Conversation
  filePath: string
}

/**
 * Persists conversations as individual JSON files under Electron's `userData`
 * directory.
 *
 * Layout:
 *   userData/conversations/state.json              — active conversation id
 *   userData/conversations/general/<id>.json       — general chats
 *   userData/conversations/<projectId>/<id>.json   — project chats
 *
 * Files are loaded into an in-memory cache once, then kept in sync on every
 * write — so `list`/`delete` never rescan the disk. Conversation and project
 * ids are validated before they are used in a path, since they become file and
 * directory names.
 */
class ConversationStore {
  private baseDir = ''
  private cache: Map<string, CacheEntry> | null = null
  private stateCache: ConversationState | null = null

  /** Must be called after `app.whenReady()`. */
  init(): void {
    this.baseDir = join(app.getPath('userData'), 'conversations')
    this.ensureDir(this.baseDir)
    this.ensureDir(join(this.baseDir, GENERAL_DIR))
    this.cache = null
    log.info('Initialised at', this.baseDir)
  }

  /** Return every persisted conversation, sorted by updatedAt descending. */
  list(): Conversation[] {
    return this.listAll().filter((conversation) => !conversation.archived)
  }

  /** Return archived conversations, sorted by archivedAt/updatedAt descending. */
  listArchived(): Conversation[] {
    return this.listAll()
      .filter((conversation) => conversation.archived)
      .sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt))
  }

  /** Return every persisted conversation, sorted by updatedAt descending. */
  listAll(): Conversation[] {
    return [...this.ensureCache().values()]
      .map((entry) => entry.conversation)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Return conversations for a specific project (or general chats). */
  listByProject(projectId: string | null): Conversation[] {
    return this.list().filter((c) => c.projectId === projectId)
  }

  /** Persist a single conversation, keeping the cache in sync. */
  save(conversation: Conversation): void {
    assertSafeId(conversation.id, 'conversation id')
    const dir = this.dirForProject(conversation.projectId)
    this.ensureDir(dir)
    const filePath = join(dir, `${conversation.id}.json`)

    // If the conversation moved between projects, remove the stale file.
    const existing = this.ensureCache().get(conversation.id)
    if (existing && existing.filePath !== filePath) this.removeFile(existing.filePath)

    try {
      writeFileSync(filePath, JSON.stringify(conversation, null, 2), 'utf-8')
      this.ensureCache().set(conversation.id, { conversation, filePath })
    } catch (error) {
      log.error('Failed to save conversation:', filePath, error)
      throw error
    }
  }

  /** Archive a single conversation so it can be restored later. */
  delete(id: string): void {
    this.archive(id)
  }

  archive(id: string): void {
    assertSafeId(id, 'conversation id')
    const entry = this.ensureCache().get(id)
    if (!entry) return
    this.save({
      ...entry.conversation,
      archived: true,
      archivedAt: Date.now(),
      updatedAt: Date.now()
    })
    const state = this.getState()
    if (state.activeConversationId === id) this.setState({ activeConversationId: null })
  }

  restore(id: string): void {
    assertSafeId(id, 'conversation id')
    const entry = this.ensureCache().get(id)
    if (!entry) return
    this.save({
      ...entry.conversation,
      archived: false,
      archivedAt: undefined,
      updatedAt: Date.now()
    })
  }

  /** Permanently delete a single conversation. */
  deletePermanent(id: string): void {
    assertSafeId(id, 'conversation id')
    const entry = this.ensureCache().get(id)
    if (!entry) return
    this.removeFile(entry.filePath)
    this.ensureCache().delete(id)
    const state = this.getState()
    if (state.activeConversationId === id) this.setState({ activeConversationId: null })
  }

  /** Archive every active conversation (all projects and general chats) and clear active state. */
  deleteAll(): void {
    for (const entry of this.ensureCache().values()) {
      if (entry.conversation.archived) continue
      this.save({
        ...entry.conversation,
        archived: true,
        archivedAt: Date.now(),
        updatedAt: Date.now()
      })
    }
    this.setState({ activeConversationId: null })
  }

  deleteArchived(ids: string[]): void {
    for (const id of ids) {
      this.deletePermanent(id)
    }
  }

  /** Archive all conversations belonging to a project. */
  deleteByProject(projectId: string): void {
    this.archiveByProject(projectId)
  }

  archiveByProject(projectId: string): void {
    assertSafeId(projectId, 'project id')
    for (const entry of this.ensureCache().values()) {
      if (entry.conversation.projectId !== projectId || entry.conversation.archived) continue
      this.save({
        ...entry.conversation,
        archived: true,
        archivedAt: Date.now(),
        updatedAt: Date.now()
      })
    }
    const state = this.getState()
    const active = state.activeConversationId
    if (active && this.ensureCache().get(active)?.conversation.projectId === projectId) {
      this.setState({ activeConversationId: null })
    }
  }

  restoreByProject(projectId: string): void {
    assertSafeId(projectId, 'project id')
    for (const entry of this.ensureCache().values()) {
      if (entry.conversation.projectId !== projectId || !entry.conversation.archived) continue
      this.save({
        ...entry.conversation,
        archived: false,
        archivedAt: undefined,
        updatedAt: Date.now()
      })
    }
  }

  /** Permanently delete all conversations belonging to a project. */
  deleteByProjectPermanent(projectId: string): void {
    assertSafeId(projectId, 'project id')
    const dir = this.dirForProject(projectId)
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        log.warn('Failed to delete project conversations:', dir, error)
      }
    }
    const cache = this.ensureCache()
    for (const [id, entry] of cache) {
      if (entry.conversation.projectId === projectId) cache.delete(id)
    }
  }

  /** Read the persisted active-conversation state. */
  getState(): ConversationState {
    if (this.stateCache) return this.stateCache
    const filePath = join(this.baseDir, STATE_FILE)
    if (!existsSync(filePath)) return { activeConversationId: null }
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as ConversationState
      this.stateCache = { activeConversationId: raw.activeConversationId ?? null }
      return this.stateCache
    } catch (error) {
      log.warn('Failed to read conversation state, using defaults:', error)
      return { activeConversationId: null }
    }
  }

  /** Persist the active-conversation state. */
  setState(state: ConversationState): void {
    const filePath = join(this.baseDir, STATE_FILE)
    this.stateCache = state
    try {
      writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8')
    } catch (error) {
      log.error('Failed to save conversation state:', filePath, error)
      throw error
    }
  }

  /** Build (once) and return the in-memory conversation cache. */
  private ensureCache(): Map<string, CacheEntry> {
    if (this.cache) return this.cache
    const cache = new Map<string, CacheEntry>()
    for (const filePath of this.listFiles()) {
      const conversation = this.readFile(filePath)
      if (conversation) cache.set(conversation.id, { conversation, filePath })
    }
    this.cache = cache
    return cache
  }

  private listFiles(): string[] {
    const files: string[] = []
    if (!existsSync(this.baseDir)) return files
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dirPath = join(this.baseDir, entry.name)
      for (const file of readdirSync(dirPath)) {
        if (file.endsWith('.json')) files.push(join(dirPath, file))
      }
    }
    return files
  }

  private readFile(filePath: string): Conversation | null {
    try {
      const conversation = JSON.parse(readFileSync(filePath, 'utf-8')) as Conversation
      return {
        ...conversation,
        archived: conversation.archived ?? false
      }
    } catch {
      return null
    }
  }

  private removeFile(filePath: string): void {
    try {
      rmSync(filePath)
    } catch (error) {
      log.warn('Failed to delete conversation file:', filePath, error)
    }
  }

  private dirForProject(projectId: string | null): string {
    if (projectId !== null) assertSafeId(projectId, 'project id')
    return join(this.baseDir, projectId ?? GENERAL_DIR)
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

/** Guard against path traversal via ids that become file/directory names. */
function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`Unsafe ${label}: "${id}"`)
}

export const conversationStore = new ConversationStore()
