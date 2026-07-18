/**
 * Persisted local semantic code index — lets `search_code` find relevant
 * code by meaning instead of exact-string matching (see `search_files`).
 * Everything here is plain data; the embedding math and file-walking live in
 * `src/main/codeIndex/`.
 */

/** One chunk of a file's text, the unit both indexing and search operate on. */
export interface CodeChunk {
  /** Workspace-relative, forward-slash-normalized path. */
  filePath: string
  /** 1-indexed, inclusive. */
  startLine: number
  /** 1-indexed, inclusive. */
  endLine: number
  text: string
}

/** A chunk plus its embedding vector, as persisted. */
export interface CodeIndexEntry extends CodeChunk {
  vector: number[]
}

/**
 * Per-file bookkeeping so re-indexing can skip unchanged files (cheap `stat`
 * comparison) and know exactly which chunks to drop when a file changes or
 * is deleted.
 */
export interface CodeIndexManifestEntry {
  mtimeMs: number
  size: number
}

/** The full persisted shape for one project's code index. */
export interface CodeIndexFile {
  version: number
  /**
   * The embedding model's vector dimensionality entries were built with. A
   * mismatch (e.g. after ever switching embedding models) invalidates the
   * whole index rather than silently comparing incompatible vectors.
   */
  vectorSize: number
  entries: CodeIndexEntry[]
  manifest: Record<string, CodeIndexManifestEntry>
}

export interface CodeSearchResult extends CodeChunk {
  /** Cosine similarity to the query, in [-1, 1] — higher is more relevant. */
  score: number
}
