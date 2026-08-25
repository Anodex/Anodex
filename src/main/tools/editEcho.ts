/**
 * What an edit actually produced, phrased the way a read would have returned it.
 *
 * ## Why an edit answers with content at all
 *
 * `edit_file` used to answer "Edited ui.py." and nothing else. That is true and
 * it is not enough: the moment an edit lands, the model's picture of the file is
 * stale in two ways at once — it cannot see the text it just produced in place,
 * and every line number below the edit has moved by an unknown amount. The only
 * way to recover either was to read the file again.
 *
 * So it did. In the run that prompted this (conversation
 * `c_ab40c932`, 91 tool calls, stopped at its round budget with the task
 * unfinished) a single 700-line file took 35 of those 91 calls: 9 edits and 26
 * reads, 11 of the reads landing within two calls of an edit to that same file.
 * The turn ran out of budget re-acquiring what it had just written.
 *
 * Every existing guard was blind to it, and correctly so. The loop guard keys on
 * exact arguments, and `lines 428-462` is not `lines 428-500`. Read coverage and
 * the same-file read cap are both cleared by `noteMutation`, because after an
 * edit the old coverage genuinely does describe text that no longer exists. Each
 * mechanism was right on its own; between them sat a model with every reason to
 * re-read and no cheaper way to see the result.
 *
 * Answering with the edited region closes that gap by supply rather than by
 * restriction: nothing is blocked, nothing is refused, and a model that still
 * wants to read is still served. It just rarely needs to.
 *
 * ## What it costs
 *
 * A window of a few dozen lines, once, against a round trip whose result is
 * usually larger and which also costs a full generation and its latency. When
 * the window will not fit the turn's remaining budget, or the change is too
 * sprawling for any window to represent honestly, it degrades to the shape of
 * the change and says so — a summary that stays true is worth more than an
 * excerpt that misleads.
 */

/** Lines of unchanged context shown either side of the change, for orientation. */
const CONTEXT_LINES = 4

/**
 * Beyond this the echo has stopped being a window and become a copy of the file,
 * which is the thing this exists to avoid sending.
 */
const MAX_ECHO_LINES = 80

export interface EditEcho {
  /** The full model-facing result for the edit. */
  modelResult: string
  /** Short UI detail, e.g. `1 replacement, now 704 lines`. */
  detail: string
}

export function describeEditResult(options: {
  relativePath: string
  original: string
  updated: string
  /** Characters this result may spend, already clamped to the turn's budget. */
  charBudget: number
  /** What the edit did, for the opening sentence — e.g. `1 replacement`. */
  action: string
}): EditEcho {
  const { relativePath, original, updated, charBudget, action } = options
  const originalLines = original.split('\n')
  const updatedLines = updated.split('\n')
  const total = updatedLines.length
  const shift = total - originalLines.length

  const span = changedSpan(originalLines, updatedLines)
  const opening = `Edited ${relativePath} (${action}).`
  const shiftNote = describeShift(shift, span === null ? total : span.start + 1)

  if (span === null) {
    // Byte-identical. `edit_file` cannot reach here (it requires a match) but a
    // `replace_lines` that rewrites a range with itself can.
    return { modelResult: `${opening} The file is unchanged.`, detail: action }
  }

  const from = Math.max(0, span.start - CONTEXT_LINES)
  const to = Math.min(total - 1, span.end + CONTEXT_LINES)
  const windowLines = to - from + 1
  const detail = `${action}, now ${total} lines`

  if (windowLines > MAX_ECHO_LINES) {
    return {
      modelResult:
        `${opening} The change spans lines ${span.start + 1}-${span.end + 1}, too much to quote ` +
        `back. The file now has ${total} lines.${shiftNote} Read the part you need if you have ` +
        'lost track of it.',
      detail
    }
  }

  const header = `[${relativePath}: lines ${from + 1}-${to + 1} of ${total} after the edit.${shiftNote}]`
  const content = updatedLines.slice(from, to + 1).join('\n')
  const body = `${opening}\n${header}\n${content}`
  if (body.length > charBudget) {
    // Truncating the window would hand back text that does not match the line
    // numbers in its own header, which is worse than not quoting it.
    return {
      modelResult:
        `${opening} The file now has ${total} lines.${shiftNote} There was not enough room left ` +
        'in this turn to quote the edited lines back.',
      detail
    }
  }
  return { modelResult: body, detail }
}

/** Where `updated` differs from `original`, in `updated`'s 0-based line numbers. */
function changedSpan(
  original: readonly string[],
  updated: readonly string[]
): { start: number; end: number } | null {
  let start = 0
  while (start < original.length && start < updated.length && original[start] === updated[start]) {
    start++
  }
  if (start === original.length && start === updated.length) return null

  let fromEnd = 0
  while (
    fromEnd < original.length - start &&
    fromEnd < updated.length - start &&
    original[original.length - 1 - fromEnd] === updated[updated.length - 1 - fromEnd]
  ) {
    fromEnd++
  }
  // A pure deletion leaves no changed line in `updated`; the seam it left behind
  // is what the model needs to see, so the span collapses onto that point.
  const end = Math.max(start, updated.length - 1 - fromEnd)
  return { start: Math.min(start, Math.max(0, updated.length - 1)), end }
}

function describeShift(shift: number, firstChangedLine: number): string {
  if (shift === 0) return ''
  const direction = shift > 0 ? 'gained' : 'lost'
  const count = Math.abs(shift)
  return (
    ` The file ${direction} ${count} line${count === 1 ? '' : 's'}, so numbers after line ` +
    `${firstChangedLine} have shifted.`
  )
}
