import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  CreateMemoryRequest,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  UpdateMemoryRequest
} from '@shared/memory.types'
import { createLogger } from '../utils/logger'
import { jaccardSimilarity } from './textSimilarity'

const log = createLogger('memory-store')

const MAX_ENTRIES_PER_SCOPE = 200
const GLOBAL_KEY = 'global'
/** How similar (Jaccard, same kind) a new fact must be to an existing one to update it in place instead of creating a duplicate. */
const DEDUP_SIMILARITY_THRESHOLD = 0.5

interface ScopeFile {
  entries: MemoryEntry[]
}

/**
 * Persists structured memory entries — durable facts the assistant was told to
 * remember, via `remember_fact` or added by hand in Settings → Memory — as one
 * JSON file per scope in `userData/memory/`. `global.json` holds entries visible
 * in every project; `<projectId>.json` holds entries scoped to one project.
 *
 * Deliberately a separate store from `ProjectMemoryStore` (the small activity
 * ledger of touched files / task summaries): that one is an automatic,
 * chronological trail, while this one only ever contains what was explicitly
 * asked to be remembered, and is meant to be browsed/edited/pinned by the user.
 */
class MemoryStore {
  private dir = ''
  private cache = new Map<string, MemoryEntry[]>()

  /** Must be called after `app.whenReady()`. */
  init(): void {
    this.dir = join(app.getPath('userData'), 'memory')
    log.info('Initialised at', this.dir)
  }

  /** Entries for one scope, newest-updated first. Excludes archived unless requested. */
  list(scope: MemoryScope, options: { includeArchived?: boolean } = {}): MemoryEntry[] {
    const entries = this.load(scopeKey(scope))
    const visible = options.includeArchived ? entries : entries.filter((e) => !e.archived)
    return [...visible].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** All entries visible for `projectId` — its own project-scoped entries plus every global one. */
  listAll(projectId: string | null, options: { includeArchived?: boolean } = {}): MemoryEntry[] {
    const global = this.list({ type: 'global' }, options)
    const project = projectId ? this.list({ type: 'project', projectId }, options) : []
    return [...project, ...global]
  }

  /**
   * Create a new memory entry — unless an existing, non-archived entry of the
   * same kind is a close match (see `findSimilarEntry`), in which case that
   * entry's text is updated in place instead. Without this, repeating a fact
   * across several conversations (e.g. the user's name coming up again) would
   * otherwise pile up near-duplicate entries rather than keeping one current one.
   */
  create(request: CreateMemoryRequest): MemoryEntry {
    const key = scopeKey(request.scope)
    const entries = this.load(key)

    const existing = findSimilarEntry(entries, request.kind, request.text)
    if (existing) return this.update(request.scope, existing.id, { text: request.text })

    const now = Date.now()
    const entry: MemoryEntry = {
      id: randomUUID(),
      kind: request.kind,
      text: request.text,
      scope: request.scope,
      source: request.source,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false
    }
    this.persist(key, capEntries([entry, ...entries]))
    return entry
  }

  update(scope: MemoryScope, id: string, patch: UpdateMemoryRequest): MemoryEntry {
    const key = scopeKey(scope)
    const entries = this.load(key)
    const index = entries.findIndex((e) => e.id === id)
    if (index === -1) throw new Error(`Memory entry not found: ${id}`)
    const next: MemoryEntry = {
      ...entries[index],
      text: patch.text?.trim() || entries[index].text,
      kind: patch.kind ?? entries[index].kind,
      pinned: patch.pinned ?? entries[index].pinned,
      archived: patch.archived ?? entries[index].archived,
      updatedAt: Date.now()
    }
    entries[index] = next
    this.persist(key, entries)
    return next
  }

  delete(scope: MemoryScope, id: string): void {
    const key = scopeKey(scope)
    this.persist(
      key,
      this.load(key).filter((e) => e.id !== id)
    )
  }

  /** Remove every project-scoped memory for a deleted project. Global entries are untouched. */
  deleteAllForProject(projectId: string): void {
    const key = scopeKey({ type: 'project', projectId })
    this.cache.delete(key)
    try {
      const file = this.filePath(key)
      if (existsSync(file)) writeFileSync(file, JSON.stringify({ entries: [] }, null, 2), 'utf-8')
    } catch (error) {
      log.warn('Failed to clear project memory:', error)
    }
  }

  private load(key: string): MemoryEntry[] {
    const cached = this.cache.get(key)
    if (cached) return cached

    const file = this.filePath(key)
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf-8')) as ScopeFile
        const entries = raw.entries ?? []
        this.cache.set(key, entries)
        return entries
      } catch (error) {
        log.warn('Failed to parse memory file, starting fresh:', error)
      }
    }

    this.cache.set(key, [])
    return []
  }

  private persist(key: string, entries: MemoryEntry[]): void {
    this.cache.set(key, entries)
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.filePath(key), JSON.stringify({ entries }, null, 2), 'utf-8')
    } catch (error) {
      log.error('Failed to persist memory:', error)
    }
  }

  private filePath(key: string): string {
    return join(this.dir, `${key}.json`)
  }
}

function scopeKey(scope: MemoryScope): string {
  return scope.type === 'global' ? GLOBAL_KEY : scope.projectId
}

/**
 * Find a non-archived entry of the same kind whose text is similar enough to
 * treat `text` as a restatement of it rather than a new fact. Exported for
 * unit testing.
 */
export function findSimilarEntry(
  entries: MemoryEntry[],
  kind: MemoryKind,
  text: string
): MemoryEntry | undefined {
  return entries.find(
    (e) =>
      !e.archived && e.kind === kind && jaccardSimilarity(e.text, text) >= DEDUP_SIMILARITY_THRESHOLD
  )
}

/**
 * Cap the number of stored entries per scope, evicting the oldest non-pinned
 * entry first. This only bounds disk/list growth — retrieval already caps how
 * many entries reach the prompt, so this cap can stay generous.
 * Exported for unit testing.
 */
export function capEntries(entries: MemoryEntry[]): MemoryEntry[] {
  if (entries.length <= MAX_ENTRIES_PER_SCOPE) return entries
  const pinned = entries.filter((e) => e.pinned)
  const unpinned = entries.filter((e) => !e.pinned)
  const keepUnpinned = Math.max(0, MAX_ENTRIES_PER_SCOPE - pinned.length)
  return [...pinned, ...unpinned.slice(0, keepUnpinned)]
}

export const memoryStore = new MemoryStore()
