/**
 * "Every day at 6pm remind me to water the fern" → name "Water the fern", a
 * reminder.
 *
 * The phone's Scheduler has one box for when and what, and sends the whole
 * sentence as the prompt with no name and no kind. The task was then named with
 * the whole sentence, timing included, and "remind me to" made an AI task that
 * would run the model at 6 PM instead of reminding anybody. This takes out what
 * `parseWhen` reads as timing and says whether the sentence asked for a reminder.
 *
 * Only the phrases `parseWhen` understands are removed, and bare weekday names
 * stay ("the Monday report"): a word that might be the subject is left in.
 */
const DAY = '(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?'
const UNIT = '(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?)'
const TIME = '(?:\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\.?|\\d{1,2}:\\d{2}|noon|midnight|midday)'

const TIMING = [
  // "every day", "every other week", "every 2 hours", "every Monday and Friday"
  `\\b(?:every|each)\\s+(?:other\\s+)?(?:\\d+\\s*)?(?:weekdays?|weekends?|${UNIT}|morning|afternoon|evening|night|${DAY}(?:\\s*(?:,|and|&)\\s*${DAY})*)\\b`,
  // "on the last Friday of the month", "on the 1st"
  `\\bon\\s+the\\s+(?:first|second|third|fourth|last|\\d{1,2}(?:st|nd|rd|th)?)(?:\\s+(?:${DAY}|day))?(?:\\s+of\\s+(?:the|every|each)\\s+month)?`,
  '\\bof\\s+(?:the|every|each)\\s+month\\b',
  `\\bon\\s+${DAY}(?:\\s*(?:,|and|&)\\s*${DAY})*`,
  `\\bin\\s+(?:about\\s+|around\\s+)?\\d+\\s*(?:m|h|d|w|${UNIT})\\b`,
  '\\b(?:today|tonight|tomorrow)(?:\\s+(?:morning|afternoon|evening|night))?\\b',
  '\\bthis\\s+(?:morning|afternoon|evening)\\b',
  `\\b(?:at\\s+)?${TIME}(?![\\w:])`,
  '\\bat\\s+\\d{1,2}\\b'
].map((source) => new RegExp(source, 'gi'))

/**
 * A cadence said in one word. Removed only when nothing else in the sentence was
 * timing: "Remind me daily to stretch" loses it, while "Weekly review every
 * Friday at 4pm" keeps it, because there it is the name.
 */
const CADENCE_WORD = /\b(?:daily|nightly|hourly|weekly|monthly|weekdays|weekends)\b/gi

const REMINDER = /\bremind\s+me\s+(?:to\s+|about\s+|that\s+)?/i
/** What is left at either end once the timing is gone: "," "and" "then" "to" … */
const LOOSE_ENDS =
  /^(?:[\s,.;:–—-]|and\b|then\b|to\b|about\b|at\b|on\b|please\b)+|(?:[\s,;:–—-]|and\b|then\b|at\b|on\b)+$/gi

export interface TaskWords {
  /** What to do, without the timing: "Water the fern". The whole text if nothing is left. */
  what: string
  /** The sentence asked to be reminded rather than for work to be done. */
  reminder: boolean
}

export function splitTaskText(text: string): TaskWords {
  const original = text.trim()
  const reminder = REMINDER.test(original)
  let what = original.replace(REMINDER, ' ')
  const before = what
  for (const pattern of TIMING) what = what.replace(pattern, ' ')
  if (what === before) what = what.replace(CADENCE_WORD, ' ')
  what = what.replace(/\s+/g, ' ')
  // Twice: removing "then" can expose a "," and the other way round.
  what = what.replace(LOOSE_ENDS, '').replace(LOOSE_ENDS, '').trim()
  if (!what) return { what: original, reminder }
  return { what: what[0].toUpperCase() + what.slice(1), reminder }
}
