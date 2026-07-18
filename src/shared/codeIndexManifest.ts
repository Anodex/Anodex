import type { CodeIndexManifestEntry } from './codeIndex.types'

export interface ManifestDiff {
  /** Files that are new or whose size/mtime changed since the last index — need re-chunking + re-embedding. */
  changedOrNew: string[]
  /** Files present in the prior manifest but not found on disk this pass — their chunks should be dropped. */
  removed: string[]
}

/**
 * Pure decision logic for `CodeIndexer.reconcile()`: which files actually
 * need work this pass. Split out from the (fs + embedding-model coupled,
 * so not directly unit-testable) orchestration for the same reason
 * `AgentRunStore.ts` extracts `normalizeAgentRun`/`reconcileInterruptedRuns`
 * — the decision of *what changed* is the part worth pinning down with real
 * tests; walking the disk and calling the embedding model isn't.
 */
export function diffManifest(
  priorManifest: Record<string, CodeIndexManifestEntry>,
  currentFiles: Record<string, CodeIndexManifestEntry>
): ManifestDiff {
  const changedOrNew: string[] = []
  for (const [path, current] of Object.entries(currentFiles)) {
    const prior = priorManifest[path]
    if (!prior || prior.size !== current.size || prior.mtimeMs !== current.mtimeMs) {
      changedOrNew.push(path)
    }
  }

  const removed = Object.keys(priorManifest).filter((path) => !(path in currentFiles))

  return { changedOrNew, removed }
}
