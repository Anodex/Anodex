export { describeRecurrence, formatTimeOfDay } from '@shared/parseWhen'

/** A run over this is worth calling out as late rather than treating as on time. */
const NOTABLE_DELAY_MS = 60_000

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

/** How long a run took, e.g. "0.8s", "18.6s", "2m 04s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * Why a run didn't happen when it should have, or null when it was on time and
 * lost nothing — see `TaskRunRecord.delayedMs`/`skippedSlots`.
 */
export function describeRunTiming(delayedMs: number, skippedSlots: number): string | null {
  const parts: string[] = []
  if (delayedMs >= NOTABLE_DELAY_MS) {
    parts.push(`started ${formatDuration(delayedMs)} late — another task was running`)
  }
  if (skippedSlots > 0) {
    parts.push(`${skippedSlots} run${skippedSlots === 1 ? '' : 's'} skipped`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}
