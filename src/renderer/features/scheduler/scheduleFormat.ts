export { describeRecurrence, formatTimeOfDay } from '@shared/parseWhen'
// Moved to shared so the main process can render the same countdown for the
// `anodex_status` tool; re-exported here so every existing caller is unchanged.
export { formatNextRun } from '@shared/relativeTime'
import { NOTABLE_DELAY_MS } from '@shared/relativeTime'

/** Inside this much of the next run, the wait is worth showing as imminent. */
export const IMMINENT_MS = 60_000

/**
 * How far through the wait to a task's next run, as 0–1 — or null when there
 * is no honest fraction to draw, which is the case for a task that will never
 * fire again and for one whose wait has no known start.
 *
 * The span is measured from when this wait actually began (the previous run,
 * or task creation for one that has never run) rather than derived from the
 * recurrence period. That keeps it truthful for a task whose schedule was
 * edited mid-wait, and for the first wait of a task that has no previous run
 * to measure from — in both cases a period-derived fraction would claim
 * progress the clock can't back.
 */
export function nextRunProgress(
  waitStartedAt: number | null,
  nextRunAt: number | null,
  now: number = Date.now()
): number | null {
  if (waitStartedAt === null || nextRunAt === null) return null
  const span = nextRunAt - waitStartedAt
  if (span <= 0) return null
  return Math.min(1, Math.max(0, (now - waitStartedAt) / span))
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
