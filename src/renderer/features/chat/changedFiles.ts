import { diffStats } from '@shared/diffRows'
import type { ToolCall } from '@shared/tools.types'

/** One file a turn changed, and by how much when the turn recorded a diff for it. */
export interface ChangedFile {
  /** Workspace-relative, forward-slashed. */
  path: string
  name: string
  /** Absent for a change with no diff on record, such as a delete or a move. */
  added?: number
  removed?: number
}

/**
 * The files a run of tool calls changed, once each, in the order they were
 * first touched.
 *
 * Several edits to one file count as one change, measured from what the file
 * was before the first to what it was after the last, so "+214" is the net
 * size of the change rather than the sum of every intermediate rewrite.
 *
 * Only successful writes: a failed one changed nothing, and `touchedPaths` is
 * the authoritative record of what a call actually altered.
 */
export function changedFilesOf(calls: readonly ToolCall[]): ChangedFile[] {
  const byPath = new Map<string, { before?: string; after?: string }>()
  for (const call of calls) {
    if (call.kind !== 'write' || call.status !== 'success') continue
    const paths = call.touchedPaths ?? (call.diff ? [call.diff.path] : [])
    for (const raw of paths) {
      const path = normalizePath(raw)
      const entry = byPath.get(path) ?? {}
      if (call.diff && normalizePath(call.diff.path) === path) {
        entry.before ??= call.diff.before
        entry.after = call.diff.after
      }
      byPath.set(path, entry)
    }
  }
  return [...byPath].map(([path, diff]) => {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (diff.before === undefined || diff.after === undefined) return { path, name }
    return { path, name, ...diffStats(diff.before, diff.after) }
  })
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}
