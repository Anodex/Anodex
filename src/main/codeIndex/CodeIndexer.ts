import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { shouldIndexFile, chunkText } from '@shared/codeChunking'
import { cosineSimilarity } from '@shared/cosineSimilarity'
import { diffManifest } from '@shared/codeIndexManifest'
import { indexedManifest } from '@shared/indexedManifest'
import type {
  CodeIndexEntry,
  CodeIndexManifestEntry,
  CodeSearchResult
} from '@shared/codeIndex.types'
import { SKIP_DIRS } from '../tools/fileTools'
import { codeIndexStore } from './CodeIndexStore'
import { embeddingService } from './EmbeddingService'
import { createLogger } from '../utils/logger'

const log = createLogger('code-indexer')

/** Don't re-walk a project's files more often than this — cheap when nothing changed, but avoids re-stat'ing every file on every single turn. */
const RECHECK_THROTTLE_MS = 60_000
const STORE_VERSION = 1
/** Cap on total indexed chunks per project — bounds worst-case memory/search cost on a very large codebase. */
const MAX_INDEXED_CHUNKS = 20_000

/** Not persisted — resets on app restart, which just means one extra reconcile pass, never incorrect behavior. */
const inFlight = new Set<string>()
const lastCheckedAt = new Map<string, number>()

interface WalkedFile {
  relativePath: string
  absolutePath: string
  size: number
  mtimeMs: number
}

/**
 * Orchestrates the semantic code index: walking a project's files, deciding
 * what changed (`diffManifest`), chunking + embedding only that, and
 * searching the result. `CodeIndexStore` is purely the read/write layer;
 * this owns the actual logic, same Store+Service split used everywhere else
 * in this codebase.
 */
class CodeIndexer {
  /**
   * Bring a project's index up to date with what's on disk. Fire-and-forget
   * by design — `workspaceContext.ts` calls this without awaiting it, so a
   * turn's response is never blocked on indexing; whatever's fresh by the
   * time a later `search_code` call runs is what benefits. Throttled
   * per-project and single-flighted so many turns in quick succession don't
   * each kick off a redundant full workspace walk.
   *
   * Deliberately does nothing synchronous beyond plain-JS Map/Date checks —
   * `embeddingService.isAvailable()` (which touches Electron's `app` module)
   * is checked inside `reconcile()` instead, so a call from a context where
   * Electron isn't running (e.g. a unit test exercising `workspaceContext.ts`)
   * can never throw here; any failure surfaces as a caught, logged rejection.
   */
  ensureFresh(projectId: string, workspaceRoot: string): void {
    if (inFlight.has(projectId)) return
    const last = lastCheckedAt.get(projectId) ?? 0
    if (Date.now() - last < RECHECK_THROTTLE_MS) return

    inFlight.add(projectId)
    this.reconcile(projectId, workspaceRoot)
      .catch((error) => log.warn('Background code index reconcile failed:', projectId, error))
      .finally(() => {
        inFlight.delete(projectId)
        lastCheckedAt.set(projectId, Date.now())
      })
  }

  /** Semantic search over a project's already-built index. Empty if nothing has been indexed yet. */
  async search(projectId: string, query: string, topK: number): Promise<CodeSearchResult[]> {
    const index = codeIndexStore.get(projectId)
    if (!index || index.entries.length === 0) return []

    const queryVector = await embeddingService.embed(query)
    return index.entries
      .map((entry) => ({
        filePath: entry.filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        text: entry.text,
        score: cosineSimilarity(queryVector, entry.vector)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  private async reconcile(projectId: string, workspaceRoot: string): Promise<void> {
    if (!embeddingService.isAvailable()) return
    const existing = codeIndexStore.get(projectId)
    const walked = await this.walk(workspaceRoot)

    const currentManifest: Record<string, CodeIndexManifestEntry> = {}
    const byPath = new Map<string, WalkedFile>()
    for (const file of walked) {
      currentManifest[file.relativePath] = { size: file.size, mtimeMs: file.mtimeMs }
      byPath.set(file.relativePath, file)
    }

    const diff = diffManifest(existing?.manifest ?? {}, currentManifest)
    if (diff.changedOrNew.length === 0 && diff.removed.length === 0 && existing) return

    const touched = new Set([...diff.changedOrNew, ...diff.removed])
    const entries: CodeIndexEntry[] = (existing?.entries ?? []).filter(
      (entry) => !touched.has(entry.filePath)
    )

    // Which files the saved manifest may claim. Everything carried over above
    // is still indexed; a file below is added only once it has been processed
    // in full. The manifest decides whether a file is ever offered again, so
    // recording one that was skipped makes the omission permanent.
    const indexed = new Set(entries.map((entry) => entry.filePath))

    for (const relativePath of diff.changedOrNew) {
      // Checked per file rather than per chunk, so a file is either fully
      // indexed or not indexed at all. Cutting off mid-file used to leave a
      // partial set of chunks recorded as a complete one.
      if (entries.length >= MAX_INDEXED_CHUNKS) break
      const file = byPath.get(relativePath)
      if (!file) continue
      let text: string
      try {
        text = await readFile(file.absolutePath, 'utf-8')
      } catch {
        continue // unreadable/binary despite the extension check — skip, not fatal
      }
      for (const chunk of chunkText(text, relativePath)) {
        try {
          const vector = await embeddingService.embed(chunk.text)
          entries.push({ ...chunk, vector })
        } catch (error) {
          log.warn('Failed to embed a chunk, skipping:', relativePath, error)
        }
      }
      // Recorded even when the file produced no chunks: it was read and
      // considered, so re-reading it every minute would be pure waste.
      indexed.add(relativePath)
    }

    codeIndexStore.save(projectId, {
      version: STORE_VERSION,
      vectorSize: embeddingService.getVectorSize() ?? existing?.vectorSize ?? 0,
      entries,
      manifest: indexedManifest(currentManifest, indexed)
    })
  }

  private async walk(root: string): Promise<WalkedFile[]> {
    const results: WalkedFile[] = []

    const visit = async (dir: string): Promise<void> => {
      let dirEntries
      try {
        dirEntries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of dirEntries) {
        const absolutePath = join(dir, entry.name)
        const relativePath = relative(root, absolutePath).split('\\').join('/')
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          // Anodex's own restore-snapshot bookkeeping, not code — genuinely
          // not worth indexing (it's internal state, not something a user
          // would want surfaced by a code search) and, verified live, can
          // contain a single JSON-escaped blob of an entire file's content
          // on one "line", which is exactly what motivated the
          // `MAX_CHUNK_CHARS` safety cap in `codeChunking.ts`. Checked by
          // relative path, not directory name alone, so an
          // unrelated user project's own "checkpoints" folder elsewhere in
          // the tree is untouched.
          if (relativePath === '.anodex/checkpoints') continue
          await visit(absolutePath)
          continue
        }
        if (!entry.isFile()) continue

        let info
        try {
          info = await stat(absolutePath)
        } catch {
          continue
        }
        if (!shouldIndexFile(relativePath, info.size)) continue
        results.push({ relativePath, absolutePath, size: info.size, mtimeMs: info.mtimeMs })
      }
    }

    await visit(root)
    return results
  }
}

export const codeIndexer = new CodeIndexer()
