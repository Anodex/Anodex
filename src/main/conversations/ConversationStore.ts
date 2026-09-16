import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import type { Conversation, ConversationState } from '@shared/conversation.types'
import {
  reconcileInterruptedConversation,
  sanitizeConversationTranscript
} from '@shared/chatSanitizer'
import { abortGeneration } from '../chat/inflightGenerations'
import { createLogger } from '../utils/logger'
import { writeJsonAtomic } from '../utils/atomicWrite'
import { conversationAssetStore } from './ConversationAssetStore'

const log = createLogger('conversations')

const STATE_FILE = 'state.json'
const GENERAL_DIR = 'general'
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** How a save should be treated. See [ConversationStore.save]. */
export interface SaveOptions {
  /**
   * True when the write came from a paired device rather than from this app.
   *
   * Such a client may be holding only the tail of the conversation, so its
   * messages are merged onto what is on disk rather than replacing it.
   */
  fromRemote?: boolean
}

/**
 * Fold a partial transcript into the stored one.
 *
 * Everything already on disk is kept, in its own order; anything the caller
 * brought that we have not seen before is appended. Matching is by message id,
 * which is unique per turn — a reply carries its request's id with `:reply`
 * appended, so the two never collide.
 *
 * `createdAt` is taken from the stored record on purpose. A client that has only
 * seen the last twenty turns cannot know when the first one was written, and the
 * one time it guesses wrong the conversation sorts to the wrong end of the list.
 */
function mergeRemoteSave(stored: Conversation, incoming: Conversation): Conversation {
  const incomingById = new Map(incoming.messages.map((message) => [message.id, message]))
  const known = new Set(stored.messages.map((message) => message.id))
  const added = incoming.messages.filter((message) => !known.has(message.id))

  return {
    ...stored,
    ...incoming,
    createdAt: stored.createdAt,
    // Where a conversation is filed is not the phone's to change. The phone has no
    // feature that moves a chat between projects, so a save carrying a different one
    // is a guess — and phone builds before 0.71.1 made exactly that guess, filing
    // every plain chat they opened into whichever project the computer had open,
    // after which its turns ran against that project's files.
    projectId: stored.projectId,
    // A turn both sides wrote keeps what is on disk, and gains only fields disk does
    // not have. The computer now records a phone's turn itself when it finishes, so
    // the phone's own save usually lands second — and only the phone knows which
    // personality answered and what it attached. The stored copy winning outright
    // would have dropped both without a trace.
    messages: [
      ...stored.messages.map((message) => {
        const theirs = incomingById.get(message.id)
        return theirs ? { ...theirs, ...definedFields(message) } : message
      }),
      ...added
    ]
  }
}

/** The fields a message actually carries, so an `undefined` never overwrites a value. */
function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined)
  ) as Partial<T>
}

/** A cached conversation together with the file that backs it. */
interface CacheEntry {
  /** The whole conversation — or, when `unloaded`, all of it but its messages. */
  conversation: Conversation
  filePath: string
  /**
   * True for an archived conversation, whose messages stay on disk until something
   * asks for them. See `ARCHIVED_HOLD_MS`.
   */
  unloaded?: boolean
  /** How many messages it has, known without holding them. */
  messageCount: number
}

/** What is kept in memory for a conversation read from, or written to, `filePath`. */
function entryFor(conversation: Conversation, filePath: string): CacheEntry {
  const messageCount = conversation.messages.length
  return conversation.archived
    ? { conversation: { ...conversation, messages: [] }, filePath, unloaded: true, messageCount }
    : { conversation, filePath, messageCount }
}

/**
 * How long archived conversations read from disk are held before being let go.
 *
 * Every conversation used to be held in memory for as long as the app ran,
 * archived ones included — on the machine this was measured on, 357 archived
 * conversations and 95MB of JSON that nothing shows until the archive is opened,
 * most of a 745MB main process. They are now read when asked for. The hold keeps
 * that from being a disk read per message when searching past chats is set to
 * include the archive, which reads every one of them for each turn.
 */
const ARCHIVED_HOLD_MS = 2 * 60_000

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
  /** Archived conversations read whole recently. See `ARCHIVED_HOLD_MS`. */
  private readonly archivedHeld = new Map<string, Conversation>()
  private archivedRelease: ReturnType<typeof setTimeout> | null = null

  /** Must be called after `app.whenReady()`. */
  init(): void {
    const userDataPath = app.getPath('userData')
    this.baseDir = join(userDataPath, 'conversations')
    conversationAssetStore.init(userDataPath)
    this.ensureDir(this.baseDir)
    this.ensureDir(join(this.baseDir, GENERAL_DIR))
    this.cache = null
    this.stateCache = null
    this.archivedHeld.clear()
    log.info('Initialised at', this.baseDir)
  }

  /** Return every persisted conversation, sorted by updatedAt descending. */
  list(): Conversation[] {
    return [...this.ensureCache().values()]
      .filter((entry) => !entry.conversation.archived)
      .map((entry) => entry.conversation)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * The file of every conversation being held whole in memory, for the memory report.
   * An archived one is only a shell here until something opens it.
   */
  heldConversationFiles(): string[] {
    return [...this.ensureCache().values()]
      .filter((entry) => !entry.unloaded)
      .map((entry) => entry.filePath)
  }

  /** Return archived conversations, sorted by archivedAt/updatedAt descending. */
  listArchived(): Conversation[] {
    return this.archivedEntries()
      .map((entry) => this.readable(entry))
      .filter((conversation): conversation is Conversation => conversation !== null)
  }

  /**
   * Archived conversations without their messages, and how many each has — all a
   * list of them shows, read without touching the disk.
   */
  listArchivedWithoutMessages(): Array<{ conversation: Conversation; messageCount: number }> {
    return this.archivedEntries().map((entry) => ({
      conversation: entry.conversation,
      messageCount: entry.messageCount
    }))
  }

  /** Return every persisted conversation, sorted by updatedAt descending. */
  listAll(): Conversation[] {
    return [...this.ensureCache().values()]
      .map((entry) => this.readable(entry))
      .filter((conversation): conversation is Conversation => conversation !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Return conversations for a specific project (or general chats). */
  listByProject(projectId: string | null): Conversation[] {
    return this.list().filter((c) => c.projectId === projectId)
  }

  /**
   * Look one conversation up by id, archived or not. Callers used to reach for
   * `listAll().find(...)`, which copies and sorts every conversation in the
   * store to answer a single-key question the cache can answer directly.
   */
  get(id: string): Conversation | undefined {
    const entry = this.ensureCache().get(id)
    return entry ? (this.readable(entry) ?? undefined) : undefined
  }

  /**
   * Persist a single conversation, keeping the cache in sync.
   *
   * `fromRemote` is not a permission flag — it says the caller is holding a
   * *partial* transcript. The phone reads a conversation through
   * `conversations:get`, which answers with the last `limit` turns because a long
   * one cannot be buffered over a socket, and it has no way to send back what it
   * was never given. A plain write of what it holds therefore replaces a thousand
   * turns with the twenty it could see.
   *
   * That is not hypothetical. A conversation started at the desk, continued once
   * from the phone, was found afterwards holding two messages and its original
   * `createdAt` — the rest overwritten by an atomic write with nothing behind it.
   *
   * So a remote save may add turns and may update the title, the project and the
   * timestamps. It may not remove a turn. The phone has no feature that deletes
   * one, so there is nothing legitimate being refused here.
   */
  save(conversation: Conversation, options: SaveOptions = {}): void {
    const normalized = sanitizeConversationTranscript(conversation).conversation
    assertSafeId(normalized.id, 'conversation id')

    const existing = this.ensureCache().get(normalized.id)
    // `whole` throws for an archived conversation that cannot be read, which fails
    // the save — rather than merging into nothing and writing that over the file.
    const toWrite =
      options.fromRemote && existing
        ? mergeRemoteSave(this.whole(existing), normalized)
        : normalized

    const dir = this.dirForProject(toWrite.projectId)
    this.ensureDir(dir)
    const filePath = join(dir, `${toWrite.id}.json`)

    try {
      writeJsonAtomic(filePath, toWrite)
      this.ensureCache().set(normalized.id, entryFor(toWrite, filePath))
      this.archivedHeld.delete(normalized.id)
    } catch (error) {
      log.error('Failed to save conversation:', filePath, error)
      throw error
    }

    // Only once the new file is safely on disk: if the conversation moved between
    // projects, drop the file it used to live in. Doing this before the write
    // would turn a failed write into data loss rather than a duplicate.
    if (existing && existing.filePath !== filePath) this.removeFile(existing.filePath)
  }

  /** Archive a single conversation so it can be restored later. */
  delete(id: string): void {
    this.archive(id)
  }

  archive(id: string): void {
    assertSafeId(id, 'conversation id')
    const entry = this.ensureCache().get(id)
    if (!entry) return
    const now = Date.now()
    this.save({
      ...this.whole(entry),
      archived: true,
      archivedAt: now,
      updatedAt: now
    })
    const state = this.getState()
    if (state.activeConversationId === id) this.setState({ activeConversationId: null })
    // A conversation that's just been archived can no longer be shown a reply
    // — stop generating into it instead of leaving the user's Stop button as
    // the only way to end an otherwise-orphaned generation.
    abortGeneration(id)
  }

  restore(id: string): void {
    assertSafeId(id, 'conversation id')
    const entry = this.ensureCache().get(id)
    if (!entry) return
    // Read whole first: restoring an archived conversation that cannot be read
    // fails here, instead of writing it back with no messages.
    this.save({
      ...this.whole(entry),
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
    conversationAssetStore.removeConversation(id)
    this.ensureCache().delete(id)
    this.archivedHeld.delete(id)
    const state = this.getState()
    if (state.activeConversationId === id) this.setState({ activeConversationId: null })
    abortGeneration(id)
  }

  /** Archive every active conversation (all projects and general chats) and clear active state. */
  deleteAll(): void {
    const now = Date.now()
    // Safe to `save()` (which writes back into this Map) while iterating it:
    // every write targets an id that already exists, and an in-place update of
    // an existing key is not revisited by a live iterator.
    for (const entry of this.ensureCache().values()) {
      if (entry.conversation.archived) continue
      this.save({
        ...entry.conversation,
        archived: true,
        archivedAt: now,
        updatedAt: now
      })
      abortGeneration(entry.conversation.id)
    }
    this.setState({ activeConversationId: null })
  }

  /**
   * Permanently delete archived conversations. Ids that name a conversation
   * which is *not* archived are skipped: this arrives straight from the renderer
   * over IPC, and the caller's intent is "empty the archive" — never "destroy a
   * live chat that happened to be in the list".
   */
  deleteArchived(ids: string[]): void {
    for (const id of ids) {
      assertSafeId(id, 'conversation id')
      const entry = this.ensureCache().get(id)
      if (entry && !entry.conversation.archived) {
        log.warn('Refusing to permanently delete a conversation that is not archived:', id)
        continue
      }
      this.deletePermanent(id)
    }
  }

  /** Archive all conversations belonging to a project. */
  deleteByProject(projectId: string): void {
    this.archiveByProject(projectId)
  }

  archiveByProject(projectId: string): void {
    assertSafeId(projectId, 'project id')
    const now = Date.now()
    for (const entry of this.ensureCache().values()) {
      if (entry.conversation.projectId !== projectId || entry.conversation.archived) continue
      this.save({
        ...entry.conversation,
        archived: true,
        archivedAt: now,
        updatedAt: now
      })
      abortGeneration(entry.conversation.id)
    }
    const state = this.getState()
    const active = state.activeConversationId
    if (active && this.ensureCache().get(active)?.conversation.projectId === projectId) {
      this.setState({ activeConversationId: null })
    }
  }

  restoreByProject(projectId: string): void {
    assertSafeId(projectId, 'project id')
    for (const entry of [...this.ensureCache().values()]) {
      if (entry.conversation.projectId !== projectId || !entry.conversation.archived) continue
      const conversation = this.readable(entry)
      if (!conversation) continue
      this.save({
        ...conversation,
        archived: false,
        archivedAt: undefined,
        updatedAt: Date.now()
      })
    }
  }

  /** Permanently delete all conversations belonging to a project. */
  deleteByProjectPermanent(projectId: string): void {
    assertSafeId(projectId, 'project id')
    const cache = this.ensureCache()
    const conversationIds = [...cache]
      .filter(([, entry]) => entry.conversation.projectId === projectId)
      .map(([id]) => id)
    const dir = this.dirForProject(projectId)
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        log.warn('Failed to delete project conversations:', dir, error)
      }
    }
    const state = this.getState()
    for (const id of conversationIds) {
      conversationAssetStore.removeConversation(id)
      cache.delete(id)
      this.archivedHeld.delete(id)
      abortGeneration(id)
      if (state.activeConversationId === id) this.setState({ activeConversationId: null })
    }
  }

  /** Read the persisted active-conversation state. */
  getState(): ConversationState {
    if (this.stateCache) return this.stateCache
    const filePath = join(this.baseDir, STATE_FILE)
    // The default is cached like any other result: on first run there is no
    // state file, and without this every caller re-hits the disk to find that out.
    if (!existsSync(filePath)) {
      this.stateCache = { activeConversationId: null }
      return this.stateCache
    }
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as ConversationState
      this.stateCache = { activeConversationId: raw.activeConversationId ?? null }
      return this.stateCache
    } catch (error) {
      log.warn('Failed to read conversation state, using defaults:', error)
      this.stateCache = { activeConversationId: null }
      return this.stateCache
    }
  }

  /** Persist the active-conversation state. */
  setState(state: ConversationState): void {
    const filePath = join(this.baseDir, STATE_FILE)
    try {
      writeJsonAtomic(filePath, state)
    } catch (error) {
      log.error('Failed to save conversation state:', filePath, error)
      throw error
    }
    // Cached only after the write lands, so a failure cannot leave this process
    // believing something the next launch will not agree with.
    this.stateCache = state
  }

  /** Build (once) and return the in-memory conversation cache. */
  private ensureCache(): Map<string, CacheEntry> {
    if (this.cache) return this.cache
    const cache = new Map<string, CacheEntry>()
    for (const filePath of this.listFiles()) {
      const conversation = this.readFile(filePath)
      if (conversation) cache.set(conversation.id, entryFor(conversation, filePath))
    }
    this.cache = cache
    return cache
  }

  private archivedEntries(): CacheEntry[] {
    return [...this.ensureCache().values()]
      .filter((entry) => entry.conversation.archived)
      .sort(
        (a, b) =>
          (b.conversation.archivedAt ?? b.conversation.updatedAt) -
          (a.conversation.archivedAt ?? a.conversation.updatedAt)
      )
  }

  /**
   * The whole conversation, reading an archived one's messages from disk.
   *
   * Throws when that read fails. A caller about to write the conversation back
   * must not carry on with it missing its messages.
   */
  private whole(entry: CacheEntry): Conversation {
    if (!entry.unloaded) return entry.conversation
    const id = entry.conversation.id
    const held = this.archivedHeld.get(id)
    if (held) {
      this.holdArchived()
      return held
    }
    const read = this.readFile(entry.filePath)
    if (!read || read.id !== id) throw new Error(`Could not read archived conversation ${id}.`)
    this.archivedHeld.set(id, read)
    this.holdArchived()
    return read
  }

  /** `whole`, or null for one that cannot be read — for callers that only read. */
  private readable(entry: CacheEntry): Conversation | null {
    try {
      return this.whole(entry)
    } catch (error) {
      log.warn('Skipping an archived conversation that could not be read:', entry.filePath, error)
      return null
    }
  }

  /** Let go of archived conversations read whole, once nothing has asked for one for a while. */
  private holdArchived(): void {
    if (this.archivedRelease) clearTimeout(this.archivedRelease)
    this.archivedRelease = setTimeout(() => {
      this.archivedHeld.clear()
      this.archivedRelease = null
    }, ARCHIVED_HOLD_MS)
    this.archivedRelease.unref?.()
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
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
      if (!isConversationShaped(parsed)) {
        log.warn('Ignoring conversation file with unexpected shape:', filePath)
        return null
      }
      const conversation = parsed as Conversation
      const withDefaults = {
        ...conversation,
        archived: conversation.archived ?? false
      }
      const sanitized = sanitizeConversationTranscript(withDefaults)
      const normalized = reconcileInterruptedConversation(sanitized.conversation)
      if (sanitized.changed || normalized.changed) {
        try {
          writeJsonAtomic(filePath, normalized.conversation)
        } catch (error) {
          log.warn('Failed to rewrite normalized conversation:', filePath, error)
        }
      }
      conversationAssetStore.pruneConversation(normalized.conversation)
      return normalized.conversation
    } catch (error) {
      // Never swallow this silently — to the user, a conversation that fails to
      // load has simply disappeared, and the log is the only way to tell that
      // apart from "it was deleted".
      log.warn('Failed to read conversation file:', filePath, error)
      return null
    }
  }

  private removeFile(filePath: string): void {
    try {
      rmSync(filePath, { force: true })
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

/**
 * The minimum a parsed file must satisfy to be treated as a conversation. Guards
 * the cache key (an id-less record would be stored under `undefined`) and the
 * sanitizer, which maps over `messages` and would throw on anything else.
 */
function isConversationShaped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Conversation>
  return (
    typeof candidate.id === 'string' && candidate.id !== '' && Array.isArray(candidate.messages)
  )
}

export const conversationStore = new ConversationStore()
