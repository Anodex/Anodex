import { isTextFile } from './textFileExtensions'
import type { CodeChunk } from './codeIndex.types'

/** Files larger than this are skipped entirely — generated/minified/lock files aren't worth indexing. */
export const MAX_INDEXABLE_FILE_BYTES = 300 * 1024

/** Target chunk size, in lines. */
const CHUNK_LINES = 50
/** Overlap between consecutive chunks, in lines — keeps a boundary-spanning function findable from either side it lands on. */
const CHUNK_OVERLAP_LINES = 8
/**
 * Hard cap on a single chunk's character count. `CHUNK_LINES` alone doesn't
 * bound chunk size — a single pathologically long "line" (minified code, a
 * JSON blob with an entire file's content escaped into one string, as
 * `.anodex/checkpoints/*.json` genuinely does — verified live, this exact
 * case blew past the embedding model's context window) can still produce a
 * chunk far larger than any embedding model's context. ~2000 chars is
 * comfortably under typical context limits while still a meaningful chunk.
 */
export const MAX_CHUNK_CHARS = 2000

/** Whether a file is worth semantically indexing at all, by extension and size. */
export function shouldIndexFile(relativePath: string, sizeBytes: number): boolean {
  if (sizeBytes <= 0 || sizeBytes > MAX_INDEXABLE_FILE_BYTES) return false
  return isTextFile(relativePath)
}

/**
 * Splits a file's text into overlapping line-window chunks. Deliberately not
 * AST-based — a fixed-size window is far simpler, works identically across
 * every language `isTextFile` allows, and is "good enough" at the scale a
 * single project's semantic search needs (same standing philosophy as
 * `MemoryRetriever`'s own "cheap filter is enough at this scale" approach).
 * Skips whitespace-only chunks (common at a file's tail).
 */
export function chunkText(text: string, filePath: string): CodeChunk[] {
  // `''.split('\n')` is `['']`, never `[]` — an empty/whitespace-only file
  // falls out naturally via the whitespace-only skip below, no separate
  // empty-input branch needed.
  const lines = text.split('\n')
  const chunks: CodeChunk[] = []
  const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP_LINES)
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + CHUNK_LINES)
    const body = lines.slice(start, end).join('\n')
    if (body.trim().length > 0) {
      chunks.push(
        ...splitOversizedChunk({ filePath, startLine: start + 1, endLine: end, text: body })
      )
    }
    if (end >= lines.length) break
  }
  return chunks
}

/**
 * Further splits a chunk by raw character count if it exceeds
 * `MAX_CHUNK_CHARS`, regardless of line structure. Sub-pieces keep the same
 * `startLine`/`endLine` as their source chunk — recomputing exact per-piece
 * line boundaries when the split point can land mid-line isn't worth the
 * complexity; this is a safety net against an oversized embedding request,
 * not a precision feature.
 */
function splitOversizedChunk(chunk: CodeChunk): CodeChunk[] {
  if (chunk.text.length <= MAX_CHUNK_CHARS) return [chunk]

  const pieces: CodeChunk[] = []
  for (let offset = 0; offset < chunk.text.length; offset += MAX_CHUNK_CHARS) {
    pieces.push({ ...chunk, text: chunk.text.slice(offset, offset + MAX_CHUNK_CHARS) })
  }
  return pieces
}
