/**
 * Clock arithmetic rendered for a reader, shared by the Scheduler UI and by
 * anything that has to describe a time in prose.
 *
 * `formatNextRun` lived in `src/renderer/features/scheduler/scheduleFormat.ts`
 * until the `anodex_status` tool needed the same countdown from the main
 * process. It is pure and dependency-free, so it moved here whole rather than
 * being copied — `scheduleFormat` re-exports it and every existing caller and
 * test is untouched.
 */

/** A run over this is worth calling out as late rather than treating as on time. */
export const NOTABLE_DELAY_MS = 60_000

/** "In 5m 20s", or just "In 5m" when the smaller unit would read as zero. */
function pair(value: number, unit: string, remainder: number, smallerUnit: string): string {
  return remainder === 0 ? `In ${value}${unit}` : `In ${value}${unit} ${remainder}${smallerUnit}`
}

/**
 * Compact countdown to a task's next run, counting seconds once it's inside an
 * hour — e.g. "In 42s", "In 27m 14s", "In 14h 30m", "Due now". Falls back to an
 * absolute date past a week, where a countdown stops being useful.
 *
 * `now` is injectable so tests can pin the result; the countdown is otherwise
 * recomputed against the wall clock on every `useCountdown` tick.
 */
export function formatNextRun(timestamp: number | null, now: number = Date.now()): string {
  if (timestamp === null) return 'Not scheduled'
  const diffMs = timestamp - now
  if (diffMs <= 0) return 'Due now'

  const totalSeconds = Math.floor(diffMs / 1000)
  if (totalSeconds < 60) return `In ${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return pair(minutes, 'm', totalSeconds % 60, 's')

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return pair(hours, 'h', minutes % 60, 'm')

  const days = Math.floor(hours / 24)
  if (days < 7) return pair(days, 'd', hours % 24, 'h')

  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * How long ago something happened, for prose rather than a ticking UI: "just
 * now", "8m ago", "3h ago", "2d ago", then an absolute date past a week.
 *
 * Coarser than {@link formatNextRun} on purpose. A countdown earns its seconds
 * because the reader is waiting for the moment it reaches zero; a past
 * timestamp is being recalled, and "1,847s ago" is arithmetic the reader then
 * has to do themselves.
 *
 * A future timestamp is reported as "just now" rather than "in -5m": small
 * clock skew between a stored time and `Date.now()` is ordinary, and it is not
 * worth a nonsensical string.
 */
export function formatAgo(timestamp: number | null | undefined, now: number = Date.now()): string {
  if (timestamp === null || timestamp === undefined) return 'never'
  const diffMs = now - timestamp
  if (diffMs < 60_000) return 'just now'

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}
