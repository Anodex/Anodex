import { REASONING_BUDGET_MESSAGE } from './reasoningOverrun'

/**
 * Keeps llama-server's reasoning-budget note out of a reply's visible text.
 *
 * `--reasoning-budget-message` is written into the model's thinking when its
 * budget runs out, and that is where it belongs. Sometimes llama-server emits
 * it as reply content instead. Found in 8 saved replies, one from a phone
 * chat, reading "I have used my thinking budget. I will stop planning here and
 * make the next tool call now…" in the middle of the answer. The model never
 * wrote those words to the user, so they are removed as they stream.
 *
 * Streamed text arrives in pieces, so anything that could be the start of the
 * note is held back until it either completes (and is dropped) or turns out to
 * be ordinary text (and is released).
 */

const NOTE_START = REASONING_BUDGET_MESSAGE.slice(0, REASONING_BUDGET_MESSAGE.indexOf('.') + 1)
/** Every wording the note has had ends here; an earlier one said "I'll stop planning now". */
const NOTE_END = 'already worked out.'
/** Longer than any wording of the note; held text past this is not the note. */
const MAX_NOTE_CHARS = REASONING_BUDGET_MESSAGE.length * 2

export interface BudgetMessageFilter {
  /** Takes the next streamed piece and returns the text that is safe to show now. */
  push(text: string): string
  /** Releases whatever is still held once the stream ends. */
  flush(): string
}

export function createBudgetMessageFilter(): BudgetMessageFilter {
  let held = ''
  /** The space after a removed note may arrive in a later piece than the note. */
  let afterNote = false

  const push = (text: string): string => {
    held += text
    if (afterNote) {
      held = held.replace(/^\s+/, '')
      if (!held) return ''
      afterNote = false
    }
    let shown = ''
    for (;;) {
      const start = held.indexOf(NOTE_START)
      if (start === -1) {
        const keep = partialNoteStartAtEnd(held)
        shown += held.slice(0, held.length - keep)
        held = held.slice(held.length - keep)
        return shown
      }
      shown += held.slice(0, start)
      held = held.slice(start)
      const end = held.indexOf(NOTE_END)
      if (end !== -1) {
        held = held.slice(end + NOTE_END.length).replace(/^\s+/, '')
        afterNote = held.length === 0
        continue
      }
      if (held.length > MAX_NOTE_CHARS) {
        // Began like the note and never finished like it: the model's own words.
        shown += held
        held = ''
      }
      return shown
    }
  }

  const flush = (): string => {
    const rest = held
    held = ''
    return rest
  }

  return { push, flush }
}

/** Removes the note from finished text, for replies that did not stream. */
export function withoutBudgetMessage(text: string): string {
  const filter = createBudgetMessageFilter()
  return filter.push(text) + filter.flush()
}

/** How many characters at the end of `text` could be the beginning of the note. */
function partialNoteStartAtEnd(text: string): number {
  for (let length = Math.min(text.length, NOTE_START.length - 1); length > 0; length--) {
    if (NOTE_START.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}
