import type { CheckpointFileDiff, CheckpointFilePreview } from './checkpoint.types'
import { buildUnifiedDiffLines, diffStats } from './diffRows'

/**
 * How much of one file's diff a remote client is sent.
 *
 * Unchanged lines away from a change are already collapsed, so an ordinary edit
 * to an ordinary file lands far under this. What the cap is for is the other
 * shape: a generated file, a lockfile, a minified bundle — where every line
 * differs and the "diff" is the whole file twice over.
 *
 * Cutting is not hiding. `added` and `removed` are counted before the cut, so
 * the summary stays true even when the rows stop, and the client says so.
 */
export const MAX_DIFF_ROWS = 600

/** One line of a minified bundle can be the whole file. Nobody reads past this. */
export const MAX_ROW_LENGTH = 400

export function buildRemoteFileDiff(file: CheckpointFilePreview): CheckpointFileDiff {
  const before = file.before ?? ''
  const after = file.after ?? ''

  if (file.binary) {
    return {
      path: file.path,
      kind: file.kind,
      binary: true,
      added: 0,
      removed: 0,
      rows: [],
      truncated: false
    }
  }

  const stats = diffStats(before, after)
  const all = buildUnifiedDiffLines(before, after)
  const rows = all
    .slice(0, MAX_DIFF_ROWS)
    .map((row) =>
      row.text.length > MAX_ROW_LENGTH
        ? { ...row, text: `${row.text.slice(0, MAX_ROW_LENGTH)}…` }
        : row
    )

  return {
    path: file.path,
    kind: file.kind,
    binary: false,
    added: stats.added,
    removed: stats.removed,
    rows,
    truncated: all.length > rows.length
  }
}
