/** Small, pure formatting helpers used across the UI. */

export { formatBytes } from '@shared/format'

/**
 * Clock time, e.g. `9:22 PM`, or `21:22` on a 24-hour computer.
 *
 * `hour: 'numeric'`, not `'2-digit'`: the two-digit form wrote "09:22 PM" here
 * while the scheduler beside it wrote "3:27 PM", one screen showing both.
 */
export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Elapsed time, e.g. `7m 34s`, `58s` — matches the "Worked for …" turn header. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** `0:29`, `12:04`, `1:02:09`: a clock, since it counts up in front of you. */
export function formatElapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}
