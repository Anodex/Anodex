import type { CodeIndexManifestEntry } from './codeIndex.types'

/**
 * The manifest to persist: only the files whose content actually reached the
 * index.
 *
 * `CodeIndexer.reconcile` used to save the whole walked manifest regardless of
 * how much was indexed. There is a cap (`MAX_INDEXED_CHUNKS`) and the chunk
 * loop stops at it, so on a large enough project the files late in the walk
 * contribute nothing while still being recorded as current.
 *
 * That makes the omission permanent. `diffManifest` compares the stored
 * manifest against a fresh stat, sees no change, and never offers those files
 * again — not when other files are deleted, not when the cap frees up, not
 * until someone edits the file itself. `search_code` quietly stops covering
 * them and nothing reports it.
 *
 * Reachable rather than hypothetical: the largest real index measured holds
 * 6,009 chunks across 940 files, so a project of roughly three thousand
 * indexable files crosses the cap.
 */
export function indexedManifest(
  walked: Record<string, CodeIndexManifestEntry>,
  indexedPaths: Iterable<string>
): Record<string, CodeIndexManifestEntry> {
  const manifest: Record<string, CodeIndexManifestEntry> = {}
  for (const path of indexedPaths) {
    const entry = walked[path]
    // A file that vanished between the walk and the save has nothing to copy,
    // and inventing an entry would record it as permanently up to date.
    if (entry) manifest[path] = entry
  }
  return manifest
}
