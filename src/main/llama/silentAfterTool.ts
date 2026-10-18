/**
 * A turn whose model did something and then said nothing about it.
 *
 * Gemma 4 E4B through llama-server set a reminder, scheduled a run and tried to
 * send a file, and each time came back from the tool result with a single
 * token — `<eos>` — and an empty reply. Replayed by hand, `<eos>` was its most
 * likely first token after the result at about 36%, ahead of "I" at 23%, so at
 * Anodex's temperature it ended there more often than not. The person saw a
 * tool card and no words.
 *
 * Asking once more costs one short round, because everything before the
 * question is already in the runtime's cache. The same four requests replayed
 * three times each with {@link SAY_WHAT_HAPPENED} appended came back with a
 * sentence in the model's own words 12 of 12 times: "I have set a reminder for
 * you to send your timesheet every Friday at 5pm."
 */
export const SAY_WHAT_HAPPENED =
  '(Tell the person in a sentence or two what you just did and what came of it.)'

/** Longest fallback line, so a tool that returns a page does not become the reply. */
const MAX_FALLBACK_CHARS = 300

/**
 * What to show when the model stays silent even after being asked: the first
 * line of the tool's own result, which every action tool writes as its outcome
 * ("Reminder set: …", "Scheduled …", "Error: …").
 *
 * Anodex's own notes to the model — the answer cue, an evidence label — are
 * not the outcome and are skipped. Null when nothing usable is left, so the
 * caller keeps whatever it would otherwise have shown.
 */
export function lineFromToolResult(result: string | null | undefined): string | null {
  if (!result) return null
  for (const raw of result.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('[evidence ') || /^\(Answer the person\b/.test(line)) continue
    return line.length > MAX_FALLBACK_CHARS ? `${line.slice(0, MAX_FALLBACK_CHARS - 1)}…` : line
  }
  return null
}
