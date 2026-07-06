import { diffLines } from 'diff'

export type DiffLineType = 'unchanged' | 'added' | 'removed' | 'blank'

export interface UnifiedDiffLine {
  type: DiffLineType
  text: string
}

export interface SideBySideDiffRow {
  left: { type: DiffLineType; text: string }
  right: { type: DiffLineType; text: string }
}

export interface DiffStats {
  added: number
  removed: number
}

/**
 * `diffLines` chunks end with a trailing `\n` (except possibly the very last
 * chunk, if the original text didn't end in one) — strip exactly one before
 * splitting so a genuine blank line in the middle of a chunk isn't lost, but
 * the artifact of the chunk boundary itself doesn't become a phantom line.
 */
function splitIntoLines(value: string): string[] {
  return value.replace(/\n$/, '').split('\n')
}

/** One row per line, in order, prefixed +/-/space — a single scrolling column. */
export function buildUnifiedDiffLines(before: string, after: string): UnifiedDiffLine[] {
  const lines: UnifiedDiffLine[] = []
  for (const change of diffLines(before, after)) {
    const type: DiffLineType = change.added ? 'added' : change.removed ? 'removed' : 'unchanged'
    for (const text of splitIntoLines(change.value)) lines.push({ type, text })
  }
  return lines
}

/**
 * Two aligned columns (before | after). A removed block immediately followed
 * by an added block is treated as one "changed" pair and lined up row by row
 * (the shorter side padded with blank rows) — the common diff-UI heuristic
 * for showing a replacement rather than an unrelated delete-then-insert.
 */
export function buildSideBySideDiffRows(before: string, after: string): SideBySideDiffRow[] {
  const changes = diffLines(before, after)
  const rows: SideBySideDiffRow[] = []

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]

    if (!change.added && !change.removed) {
      for (const text of splitIntoLines(change.value)) {
        rows.push({ left: { type: 'unchanged', text }, right: { type: 'unchanged', text } })
      }
      continue
    }

    if (change.removed) {
      const removedLines = splitIntoLines(change.value)
      const next = changes[i + 1]
      if (next?.added) {
        const addedLines = splitIntoLines(next.value)
        const max = Math.max(removedLines.length, addedLines.length)
        for (let j = 0; j < max; j++) {
          rows.push({
            left:
              j < removedLines.length
                ? { type: 'removed', text: removedLines[j] }
                : { type: 'blank', text: '' },
            right:
              j < addedLines.length
                ? { type: 'added', text: addedLines[j] }
                : { type: 'blank', text: '' }
          })
        }
        i++ // consumed the paired added block
      } else {
        for (const text of removedLines) {
          rows.push({ left: { type: 'removed', text }, right: { type: 'blank', text: '' } })
        }
      }
      continue
    }

    // An added block with no preceding removed block (unpaired insertion).
    for (const text of splitIntoLines(change.value)) {
      rows.push({ left: { type: 'blank', text: '' }, right: { type: 'added', text } })
    }
  }

  return rows
}

/** Total added/removed line counts, for a collapsed "+N -M" summary. */
export function diffStats(before: string, after: string): DiffStats {
  let added = 0
  let removed = 0
  for (const change of diffLines(before, after)) {
    const count = splitIntoLines(change.value).length
    if (change.added) added += count
    else if (change.removed) removed += count
  }
  return { added, removed }
}
