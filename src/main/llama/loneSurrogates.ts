/**
 * Repairing text that was cut through the middle of a character.
 *
 * JavaScript strings are UTF-16, so slicing one to a character budget can land
 * between the two halves of a surrogate pair and leave an unpaired half behind.
 * `JSON.stringify` serialises that half without complaint, but llama-server
 * parses with nlohmann/json, which refuses it:
 *
 *   500 [json.exception.parse_error.101] ... invalid string: surrogate
 *   U+D800..U+DBFF must be followed by U+DC00..U+DFFF
 *
 * Observed live: a reply died mid-turn after a file read was truncated to a
 * character budget, taking the whole turn's output with it. Any emoji or other
 * astral character sitting on a truncation boundary does it, so every place
 * that slices text to a budget is a candidate and fixing them one at a time
 * would leave the next one to be found in production.
 *
 * The repair belongs here instead, at the last point before the text is
 * serialised: an unpaired half is not meaningful text under any circumstance,
 * and U+FFFD is exactly what it means -- a character that did not survive.
 */

/** Cheap reject. Most text contains no surrogate code unit at all. */
const ANY_SURROGATE = /[\uD800-\uDFFF]/

/** A high half with no low half after it, or a low half with no high half before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function replaceLoneSurrogates(value: string): string {
  if (!ANY_SURROGATE.test(value)) return value
  return value.replace(LONE_SURROGATE, '�')
}

/**
 * Walk a request payload and repair every string in it, preserving structure.
 *
 * Returns the value it was given, unchanged and by identity, when nothing
 * needed repairing -- which is almost always. A turn's messages can run to
 * hundreds of kilobytes and the array is deliberately shared and appended to
 * across rounds, so rebuilding it every round would cost real memory and would
 * quietly hand the caller a different array than the one it is accumulating
 * into.
 *
 * Messages carry text in several shapes -- a plain `content`, an array of
 * content parts for vision, and the JSON string of a tool call's arguments --
 * and a broken pair anywhere in there fails the whole request, so the walk is
 * general rather than aimed at the fields that happen to break today.
 */
export function repairLoneSurrogatesDeep<T>(value: T): T {
  return repairUnknown(value) as T
}

function repairUnknown(value: unknown): unknown {
  if (typeof value === 'string') return replaceLoneSurrogates(value)
  if (Array.isArray(value)) {
    let changed = false
    const items = (value as unknown[]).map((item) => {
      const next = repairUnknown(item)
      if (next !== item) changed = true
      return next
    })
    return changed ? items : value
  }
  if (value && typeof value === 'object') {
    let changed = false
    const repaired: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = repairUnknown(item)
      if (next !== item) changed = true
      repaired[key] = next
    }
    return changed ? repaired : value
  }
  return value
}
