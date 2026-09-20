/**
 * Turning a written reply into something worth saying out loud.
 *
 * This began as a politeness — nobody wants to hear asterisks — and the
 * measurements turned it into a performance fix. One sentence from a real reply,
 * same machine, same moment:
 *
 *     "Python 3.14.6 is available (no .NET, no ffmpeg) — so I'll build a real
 *      native desktop app in **Python + PySide6 (Qt 6)**:"        40.4 s
 *
 *     "Python 3.14.6 is available, with no .NET and no ffmpeg, so I'll build a
 *      real native desktop app in Python and PySide6."            11.8 s
 *
 * The second is *more* audio in a quarter of the time. Markup, brackets and
 * stray symbols do not merely get pronounced; they make the model take far
 * longer per second of speech it produces.
 *
 * One thing measured and deliberately **not** done: spelling numbers out.
 * "Python three point fourteen" took 25.2 s against 11.8 s for "Python 3.14.6".
 * The model reads digits perfectly well and writing them as words makes it
 * slower, so this removes symbols and leaves numbers alone.
 */

/** A fenced code block, with or without a language tag. */
const FENCE = /```[\s\S]*?```/g
/** An indented code block: four spaces at the start of a line, run together. */
const INDENTED = /(?:^|\n)(?: {4}|\t)[^\n]*(?:\n(?: {4}|\t)[^\n]*)*/g
/** `inline code`. */
const INLINE_CODE = /`([^`\n]+)`/g
/** [text](url) and bare urls. */
const LINK = /\[([^\]\n]*)\]\((?:[^)\s]*)\)/g
const BARE_URL = /\b(?:https?:\/\/|www\.)\S+/gi
/** An image, which has nothing to say at all. */
const IMAGE = /!\[[^\]\n]*\]\([^)\s]*\)/g
/** **bold**, *italic*, __bold__, _italic_, ~~struck~~. */
const EMPHASIS = /(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g
/** A heading's hashes, and a blockquote's angle. */
const HEADING = /^[ \t]*#{1,6}[ \t]+/gm
const QUOTE = /^[ \t]*>[ \t]?/gm
/** A list bullet or number at the start of a line. */
const BULLET = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm
/** A table row, which read aloud is a wall of pipes. */
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/gm
/** A horizontal rule. */
const RULE = /^[ \t]*(?:[-*_][ \t]*){3,}$/gm

/** What a skipped code block becomes, so the reply still makes sense. */
const CODE_STANDS_FOR = 'a code block'

/**
 * Symbols with nothing to say.
 *
 * Kept: letters, digits, and the punctuation that shapes speech — full stops,
 * commas, question and exclamation marks, colons, semicolons, apostrophes,
 * hyphens and dashes. Everything else is either silent or expensive.
 */
const NOISE = /[*_~`#|<>{}[\]^=+\\/@$%&]/g

/** Brackets become commas: the aside survives, the symbols do not. */
function unbracket(text: string): string {
  return text.replace(/\s*\(([^()\n]{1,120})\)\s*/g, ', $1, ')
}

/**
 * The prose of a reply, ready to be spoken.
 *
 * Returns an empty string when a reply is nothing but code, which the caller
 * should treat as "there is nothing here to say" rather than reading the
 * placeholder on its own.
 */
export function toSpokenForm(markdown: string): string {
  let text = markdown

  // Code first, before anything else can mangle what is inside it.
  text = text.replace(FENCE, ` ${CODE_STANDS_FOR}. `)
  text = text.replace(INDENTED, ` ${CODE_STANDS_FOR}. `)
  text = text.replace(IMAGE, ' ')
  text = text.replace(LINK, '$1')
  text = text.replace(BARE_URL, ' a link ')
  text = text.replace(INLINE_CODE, '$1')

  text = text.replace(TABLE_ROW, ' ')
  text = text.replace(RULE, ' ')
  text = text.replace(HEADING, '')
  text = text.replace(QUOTE, '')
  text = text.replace(BULLET, '')
  text = text.replace(EMPHASIS, '$2')

  text = unbracket(text)
  text = text.replace(NOISE, ' ')

  // Tidy up after all that removal: repeated spaces, space before punctuation,
  // and the doubled commas that unbracketing can leave behind.
  text = text.replace(/[ \t]+/g, ' ')
  // Only when the mark ends something. Without the lookahead this closed the gap
  // in "no .NET" and produced "no.NET", because a leading dot is not punctuation.
  text = text.replace(/ ([.,;:!?])(?=\s|$)/g, '$1')
  text = text.replace(/,(\s*,)+/g, ',')
  text = text.replace(/([.!?])[ ]*,/g, '$1')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/^[ ,]+/gm, '')
  text = text.trim()

  // A reply that was only code says only the placeholder, which is not worth
  // playing on its own.
  if (text === `${CODE_STANDS_FOR}.` || text === CODE_STANDS_FOR) return ''
  return text
}
