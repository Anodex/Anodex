/**
 * How a reply is broken up before it is spoken, and how long the gaps are.
 *
 * ## Why this exists
 *
 * A text-to-speech model handed a paragraph reads it as one breath. It is
 * perfectly articulate and it sounds relentless, because the thing that makes
 * speech sound considered is not the words — it is the silence between them.
 *
 * Measured rather than asserted. Claude's read-aloud, recorded off a phone, is
 * **silent 42% of the time** and its pitch moves across a 40 Hz range. Our first
 * unbroken samples were silent 26% of the time across a 19 Hz range, at the same
 * median pitch and roughly the same words per minute. Same voice register, same
 * pace, and it still sounded like it was reading *at* you rather than *to* you.
 * The gap is the gaps.
 *
 * So the text is planned into chunks with deliberate silence between them, and
 * each chunk is generated separately. That buys two things at once:
 *
 * 1. **Real pauses**, the length a person would leave, rather than whatever the
 *    model felt like.
 * 2. **A contour per sentence.** A model generating one sentence gives it a
 *    beginning and an end — a rise on a question, a fall on a full stop. The same
 *    sentence buried in a paragraph gets flattened into the middle of a longer
 *    line.
 *
 * And a third, free: the first chunk can be spoken while the second is still
 * being generated, which is most of what makes a voice feel immediate.
 *
 * ## What it is not
 *
 * Not the spoken-form reduction — deciding that a code block becomes "I've put
 * the code in the chat" happens before this, and is a separate concern with a
 * separate module. This takes text that is already meant to be said and decides
 * how to say it.
 */

export interface SpeechChunk {
  /** The words to generate as one unit. Never empty. */
  text: string
  /** Silence to insert after it, in milliseconds. */
  pauseAfterMs: number
}

export interface SpeechPlanOptions {
  /**
   * How long the first chunk may be, in words.
   *
   * Deliberately shorter than the rest. Nothing is heard until the first chunk
   * has been generated, so its length *is* the time to first word — and a
   * fifty-word opening sentence would mean two seconds of nothing while the
   * model works. After that, generation runs ahead of playback and longer chunks
   * are free.
   */
  firstChunkWords: number
  /** The cap for every chunk after the first. */
  maxChunkWords: number
}

export const DEFAULT_SPEECH_PLAN: SpeechPlanOptions = {
  firstChunkWords: 8,
  maxChunkWords: 30
}

/**
 * How long each kind of break is held.
 *
 * Lengths a person would leave, then checked by generating audio and measuring
 * it rather than by ear.
 *
 * They are not tuned to the 42% figure measured from a voice that sounds
 * considered, and an early attempt to do that was wrong: that figure counts every
 * frame below a loudness threshold, most of which is the gaps inside ordinary
 * speech. What is added here sits on top of those. The number worth checking is
 * what the finished audio measures, not what the plan promises.
 */
export const PAUSES = {
  /** Between paragraphs: a new thought. */
  paragraph: 700,
  /** After a full stop, question mark or exclamation. */
  sentence: 420,
  /** Colons and semicolons: a longer beat than a comma, because something follows. */
  clause: 260,
  /** Commas, and dashes used as parentheses. */
  comma: 190,
  /** Between pieces of one sentence split only because it was too long. */
  breath: 120
} as const

/**
 * Things that end in a full stop and are not the end of a sentence.
 *
 * Getting this wrong is the most audible failure available here: "version 0." —
 * pause — "10.15" turns a version number into two sentences, and no amount of
 * good prosody survives it.
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'eg',
  'ie',
  'no',
  'approx',
  'fig',
  'al'
])

/** A full stop inside a number, a version or a filename is not a full stop. */
function isSentenceEnd(text: string, at: number): boolean {
  const ch = text[at]
  if (ch !== '.' && ch !== '!' && ch !== '?') return false
  if (ch !== '.') return true

  const before = text.slice(Math.max(0, at - 12), at)
  const after = text.slice(at + 1, at + 3)

  // 0.10.15, 3.6, 158.4 — a digit on both sides is a number, not a stop.
  if (/\d$/.test(before) && /^\d/.test(after)) return false

  // voiceLoop.kt, index.ts — a letter immediately after with no space is a file.
  if (/^[a-zA-Z]/.test(after) && !/^\s/.test(after)) return false

  // e.g. / i.e. / U.S. — one or more single letters each followed by a dot. The
  // second dot is the one that catches people out: by then the text before it
  // reads "e.g", whose last letter is preceded by a dot rather than a space.
  if (/(^|[\s("'])([a-zA-Z]\.)*[a-zA-Z]$/.test(before)) return false

  const word = before.match(/([a-zA-Z]+)$/)?.[1]?.toLowerCase()
  if (word && ABBREVIATIONS.has(word)) return false

  // A stop with nothing after it ends the text, which is an end.
  if (at === text.length - 1) return true

  // Otherwise it needs whitespace after to be a stop rather than a decimal point
  // in something we did not anticipate.
  return /^[\s"')\]]/.test(text.slice(at + 1))
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Split one long sentence at the places a person would breathe.
 *
 * Commas first, because a comma is where the writer already said there was a
 * joint. Only if that is not enough does it fall back to splitting on word count
 * alone, which sounds worse and is why it is last.
 */
function splitLongSentence(sentence: string, limit: number): SpeechChunk[] {
  if (words(sentence) <= limit) return [{ text: sentence, pauseAfterMs: 0 }]

  const parts: SpeechChunk[] = []
  let current = ''

  const pieces = sentence.split(/(?<=[,;:])\s+/)
  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece
    if (words(candidate) > limit && current) {
      parts.push({ text: current, pauseAfterMs: pauseForEnding(current) })
      current = piece
    } else {
      current = candidate
    }
  }
  if (current) parts.push({ text: current, pauseAfterMs: 0 })

  // Still too long: a sentence with no commas at all. Break on words and hold a
  // short breath, which is the least bad option rather than a good one.
  const final: SpeechChunk[] = []
  for (const part of parts) {
    if (words(part.text) <= limit * 1.5) {
      final.push(part)
      continue
    }
    const all = part.text.split(/\s+/)
    for (let i = 0; i < all.length; i += limit) {
      const slice = all.slice(i, i + limit).join(' ')
      const last = i + limit >= all.length
      final.push({ text: slice, pauseAfterMs: last ? part.pauseAfterMs : PAUSES.breath })
    }
  }
  return final
}

function pauseForEnding(text: string): number {
  const last = text.trimEnd().slice(-1)
  if (last === ':' || last === ';') return PAUSES.clause
  if (last === ',') return PAUSES.comma
  return PAUSES.breath
}

/**
 * Text in, chunks out.
 *
 * Empty or whitespace-only input produces no chunks rather than one empty one: a
 * caller that generates audio for nothing wastes a model call and produces a
 * click.
 */
export function planSpeech(
  text: string,
  options: SpeechPlanOptions = DEFAULT_SPEECH_PLAN
): SpeechChunk[] {
  const chunks: SpeechChunk[] = []

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  paragraphs.forEach((paragraph, paragraphIndex) => {
    // Walk the paragraph, cutting at every real sentence end.
    const sentences: string[] = []
    let start = 0
    for (let i = 0; i < paragraph.length; i += 1) {
      if (!isSentenceEnd(paragraph, i)) continue
      // Take any closing quote or bracket with the sentence it belongs to.
      let end = i + 1
      while (end < paragraph.length && /["')\]]/.test(paragraph[end])) end += 1
      sentences.push(paragraph.slice(start, end).trim())
      start = end
    }
    const tail = paragraph.slice(start).trim()
    if (tail) sentences.push(tail)

    sentences.forEach((sentence, sentenceIndex) => {
      const lastOfParagraph = sentenceIndex === sentences.length - 1
      const lastOfAll = lastOfParagraph && paragraphIndex === paragraphs.length - 1

      const limit = chunks.length === 0 ? options.firstChunkWords : options.maxChunkWords
      const parts = splitLongSentence(sentence, limit)

      parts.forEach((part, partIndex) => {
        const isEnd = partIndex === parts.length - 1
        chunks.push({
          text: part.text,
          pauseAfterMs: !isEnd
            ? part.pauseAfterMs
            : lastOfAll
              ? 0 // Nothing follows, so silence at the end is just latency.
              : lastOfParagraph
                ? PAUSES.paragraph
                : PAUSES.sentence
        })
      })
    })
  })

  return chunks
}

/** Total silence a plan will insert, for checking the ratio against a target. */
export function plannedSilenceMs(chunks: SpeechChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.pauseAfterMs, 0)
}
