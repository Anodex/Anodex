const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1
})

export function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value)
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * `dateString` is a plain `YYYY-MM-DD` local calendar day, not a UTC
 * instant — parse its parts directly instead of `new Date(dateString)`,
 * which reads bare date strings as UTC midnight and can print the wrong day
 * for users west of UTC.
 */
export function formatDay(dateString: string): string {
  const [year, month, day] = dateString.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

/** Formats an hour (0-23) as a friendly hour range, e.g. `2` -> "2–3 AM". */
export function formatHourRange(hour: number): string {
  const fmt = (h: number): string =>
    new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })
  return `${fmt(hour)}–${fmt((hour + 1) % 24)}`
}
