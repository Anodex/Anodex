/**
 * Builder for `GenerateOutcome.stopDetail` — the provider's own account of why
 * a turn ended, carried alongside a `'provider-error'` stop.
 *
 * Bounded on the way in rather than at each place it is shown. The value ends
 * up in four consumers with very different tolerances: a chat bubble's error
 * line, an agent run's persisted `lastError`, a scheduled run's stored summary,
 * and a desktop toast body. Provider SDKs put the whole HTTP error body in
 * `message`, which for a rejected request can run to kilobytes of JSON — enough
 * to blow out a toast and to bloat every persisted run record that touches it.
 *
 * One bound here means no consumer has to remember to apply its own, and none
 * of them can disagree about what the limit is.
 */

/**
 * Roughly two lines of prose — long enough for the sentence that actually
 * identifies the fault ("429 rate limit exceeded", "model X does not exist"),
 * short enough to sit in a toast without pushing anything else off it.
 */
const MAX_STOP_DETAIL_CHARS = 300

/**
 * Normalize an unknown thrown value into a bounded, single-paragraph detail
 * string, or `undefined` when there is nothing worth carrying.
 *
 * Whitespace is collapsed because a stack-trace-shaped message renders as a
 * wall of blank lines in the places this is shown.
 */
export function toStopDetail(error: unknown): string | undefined {
  const collapsed = rawMessage(error).replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  return collapsed.length > MAX_STOP_DETAIL_CHARS
    ? `${collapsed.slice(0, MAX_STOP_DETAIL_CHARS).trimEnd()}…`
    : collapsed
}

/**
 * The text of a thrown value, whatever it turns out to be.
 *
 * A plain object is serialized rather than coerced: `String({})` yields
 * `[object Object]`, which tells the user nothing and hides a real reason that
 * was sitting right there in the object's fields.
 */
function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error === null || error === undefined) return ''
  if (typeof error === 'object') {
    try {
      return JSON.stringify(error) ?? ''
    } catch {
      // Circular, or carrying a throwing `toJSON` — there is nothing to report.
      return ''
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- primitive by elimination
  return String(error)
}
