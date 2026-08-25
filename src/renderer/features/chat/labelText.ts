/**
 * Wording shared by the two places Anodex describes its own work in the
 * transcript: the live status line under a streaming reply (`activityPhrase`)
 * and the collapsed summary above a finished run (`summarizeWork`).
 *
 * They differ in tense, not in style, so the sentence-shaping rules live here
 * rather than being written twice and drifting apart.
 */

/** Keep a label to a glance — the full text is always one click away on the tool card. */
export function shorten(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The inverse, for slotting an already-capitalised phrase mid-sentence
 * ("Reading camera.py" → "Thinking after reading camera.py").
 *
 * Leaves an all-caps opening word alone, so an acronym or a shell command that
 * is genuinely spelled that way is not quietly rewritten.
 */
export function lowercaseFirst(text: string): string {
  const [first = '', second = ''] = [text.charAt(0), text.charAt(1)]
  if (first === first.toLowerCase()) return text
  if (second !== '' && second === second.toUpperCase() && second !== second.toLowerCase())
    return text
  return first.toLowerCase() + text.slice(1)
}

export function basename(path: string): string {
  const normalized = path.split(String.fromCharCode(92)).join('/')
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  return trimmed.split('/').pop() || path
}
