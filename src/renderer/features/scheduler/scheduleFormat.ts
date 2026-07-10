import type { TaskRecurrence } from '@shared/scheduledTask.types'

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_PRESET = [1, 2, 3, 4, 5]

export function formatTimeOfDay(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM'
  const displayHour = hour % 12 === 0 ? 12 : hour % 12
  return `${displayHour}:${String(minute).padStart(2, '0')} ${period}`
}

function isWeekdaysPreset(weekdays: number[]): boolean {
  return (
    weekdays.length === WEEKDAYS_PRESET.length &&
    WEEKDAYS_PRESET.every((day) => weekdays.includes(day))
  )
}

/** Human description of a recurrence, e.g. "Every day at 9:00 AM", "Every 30 minutes". */
export function describeRecurrence(recurrence: TaskRecurrence): string {
  if (recurrence.type === 'interval') {
    const every = recurrence.every ?? 1
    const unit = recurrence.intervalUnit ?? 'minutes'
    return `Every ${every} ${every === 1 ? unit.slice(0, -1) : unit}`
  }

  const time = formatTimeOfDay(recurrence.hour, recurrence.minute)
  if (recurrence.type === 'once') return `Once at ${time}`
  if (recurrence.type === 'daily') return `Every day at ${time}`

  const weekdays = [...(recurrence.weekdays ?? [])].sort((a, b) => a - b)
  if (weekdays.length === 0) return `Weekly at ${time} — pick a day`
  if (weekdays.length === 7) return `Every day at ${time}`
  if (isWeekdaysPreset(weekdays)) return `Weekdays at ${time}`
  return `Every ${weekdays.map((day) => WEEKDAY_LABELS[day]).join(', ')} at ${time}`
}

/** Compact countdown/description for a task's next run, e.g. "In 5m", "In 2h", "Due now", or a date once it's over a week out. */
export function formatNextRun(timestamp: number | null): string {
  if (timestamp === null) return 'Not scheduled'
  const diffMs = timestamp - Date.now()
  if (diffMs <= 0) return 'Due now'

  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 1) return 'In under a minute'
  if (minutes < 60) return `In ${minutes}m`

  const hours = Math.round(diffMs / 3_600_000)
  if (hours < 24) return `In ${hours}h`

  const days = Math.round(diffMs / 86_400_000)
  if (days < 7) return `In ${days}d`

  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
