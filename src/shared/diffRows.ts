import { diffLines } from 'diff'

export type DiffLineType = 'unchanged' | 'added' | 'removed' | 'blank' | 'gap'

export interface UnifiedDiffLine {
  type: DiffLineType
  text: string
  oldLine: number | null
  newLine: number | null
  /** Only set on `gap` rows: how many unchanged lines were collapsed here. */
  count?: number
}

export interface SideBySideDiffCell {
  type: DiffLineType
  text: string
  line: number | null
}

export interface SideBySideDiffRow {
  left: SideBySideDiffCell
  right: SideBySideDiffCell
  /** Only set when both cells are `gap`: how many unchanged rows were collapsed here. */
  count?: number
}

export interface DiffStats {
  added: number
  removed: number
}

/** Lines of unchanged context kept immediately around each change, before collapsing the rest. */
const CONTEXT_LINES = 3

/**
 * `diffLines` chunks end with a trailing `\n` (except possibly the very last
 * chunk, if the original text didn't end in one) — strip exactly one before
 * splitting so a genuine blank line in the middle of a chunk isn't lost, but
 * the artifact of the chunk boundary itself doesn't become a phantom line.
 */
function splitIntoLines(value: string): string[] {
  return value.replace(/\n$/, '').split('\n')
}

/** Collapses long runs of "unchanged" items into a single gap marker, keeping `CONTEXT_LINES` around every change. */
function collapseContext<T>(
  items: T[],
  isChanged: (item: T) => boolean,
  makeGap: (count: number) => T
): T[] {
  const n = items.length
  const keep = new Array<boolean>(n).fill(false)
  for (let i = 0; i < n; i++) {
    if (!isChanged(items[i])) continue
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(n - 1, i + CONTEXT_LINES); j++) {
      keep[j] = true
    }
  }

  const result: T[] = []
  let hiddenRun = 0
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      if (hiddenRun > 0) {
        result.push(makeGap(hiddenRun))
        hiddenRun = 0
      }
      result.push(items[i])
    } else {
      hiddenRun++
    }
  }
  if (hiddenRun > 0) result.push(makeGap(hiddenRun))

  return result
}

/** One row per line, in order, prefixed +/-/space — a single scrolling column. */
export function buildUnifiedDiffLines(before: string, after: string): UnifiedDiffLine[] {
  const lines: UnifiedDiffLine[] = []
  let oldLine = 1
  let newLine = 1
  for (const change of diffLines(before, after)) {
    const type: DiffLineType = change.added ? 'added' : change.removed ? 'removed' : 'unchanged'
    for (const text of splitIntoLines(change.value)) {
      lines.push({
        type,
        text,
        oldLine: type === 'added' ? null : oldLine,
        newLine: type === 'removed' ? null : newLine
      })
      if (type !== 'added') oldLine++
      if (type !== 'removed') newLine++
    }
  }
  return collapseContext(
    lines,
    (line) => line.type !== 'unchanged',
    (count) => ({ type: 'gap', text: '', oldLine: null, newLine: null, count })
  )
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
  let oldLine = 1
  let newLine = 1

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]

    if (!change.added && !change.removed) {
      for (const text of splitIntoLines(change.value)) {
        rows.push({
          left: { type: 'unchanged', text, line: oldLine },
          right: { type: 'unchanged', text, line: newLine }
        })
        oldLine++
        newLine++
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
                ? { type: 'removed', text: removedLines[j], line: oldLine++ }
                : { type: 'blank', text: '', line: null },
            right:
              j < addedLines.length
                ? { type: 'added', text: addedLines[j], line: newLine++ }
                : { type: 'blank', text: '', line: null }
          })
        }
        i++ // consumed the paired added block
      } else {
        for (const text of removedLines) {
          rows.push({
            left: { type: 'removed', text, line: oldLine++ },
            right: { type: 'blank', text: '', line: null }
          })
        }
      }
      continue
    }

    // An added block with no preceding removed block (unpaired insertion).
    for (const text of splitIntoLines(change.value)) {
      rows.push({
        left: { type: 'blank', text: '', line: null },
        right: { type: 'added', text, line: newLine++ }
      })
    }
  }

  return collapseContext(
    rows,
    (row) => row.left.type !== 'unchanged' || row.right.type !== 'unchanged',
    (count) => ({
      left: { type: 'gap', text: '', line: null },
      right: { type: 'gap', text: '', line: null },
      count
    })
  )
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
