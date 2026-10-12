import { useMemo, useState } from 'react'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import { formatClock } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { buildMonth, monthGrid, type MonthEntry } from '@shared/scheduleMonth'
import styles from './MonthView.module.css'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const STATE_LABEL: Record<MonthEntry['state'], string> = {
  success: 'Done',
  error: "Didn't run",
  stopped: 'Stopped',
  upcoming: 'Coming up'
}

/**
 * The Scheduler as a month: what happened and what is coming, day by day.
 *
 * Tasks that happen every day or every weekday are listed once above the grid,
 * so the squares show only what makes a day different. Choosing a day lists all
 * of it, frequent tasks included; choosing a row opens that task's report.
 */
export function MonthView({
  tasks,
  onOpenTask
}: {
  tasks: ScheduledTask[]
  onOpenTask: (taskId: string) => void
}): JSX.Element {
  const today = new Date()
  const [shown, setShown] = useState({ year: today.getFullYear(), month: today.getMonth() })
  const isThisMonth = shown.year === today.getFullYear() && shown.month === today.getMonth()
  const [chosen, setChosen] = useState<number>(isThisMonth ? today.getDate() : 1)
  const plan = useMemo(() => buildMonth(tasks, shown.year, shown.month), [tasks, shown])

  const move = (delta: number): void => {
    const next = new Date(shown.year, shown.month + delta, 1)
    setShown({ year: next.getFullYear(), month: next.getMonth() })
    const nowMonth =
      next.getFullYear() === today.getFullYear() && next.getMonth() === today.getMonth()
    setChosen(nowMonth ? today.getDate() : 1)
  }

  const goToday = (): void => {
    setShown({ year: today.getFullYear(), month: today.getMonth() })
    setChosen(today.getDate())
  }

  const title = new Date(shown.year, shown.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  })
  const isPast = (day: number): boolean =>
    new Date(shown.year, shown.month, day + 1).getTime() <= Date.now()
  const chosenEntries = [
    ...(plan.days.get(chosen) ?? []),
    ...(plan.everyByDay.get(chosen) ?? [])
  ].sort((a, b) => a.at - b.at)
  const chosenLabel = new Date(shown.year, shown.month, chosen).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  return (
    <div className={styles.month}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.nav}
          onClick={() => move(-1)}
          aria-label="Previous month"
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <span className={styles.title}>{title}</span>
        <button
          type="button"
          className={styles.nav}
          onClick={() => move(1)}
          aria-label="Next month"
        >
          <Icon name="chevron-right" size={14} />
        </button>
        {!isThisMonth && (
          <button type="button" className={styles.today} onClick={goToday}>
            Today
          </button>
        )}
      </div>

      {plan.every.length > 0 && (
        <div className={styles.every} aria-label="Happens often">
          {plan.every.map((entry) => (
            <span key={entry.taskId} className={entry.reminder ? styles.everyReminder : undefined}>
              <b>{entry.cadence}</b> · {entry.name}
              {entry.hour !== null && entry.minute !== null
                ? ` · ${formatClock(new Date(2000, 0, 1, entry.hour, entry.minute).getTime())}`
                : ''}
            </span>
          ))}
        </div>
      )}

      <div className={styles.body}>
        <div className={styles.grid} role="grid" aria-label={title}>
          {WEEKDAYS.map((day) => (
            <div key={day} className={styles.dow} role="columnheader">
              {day}
            </div>
          ))}
          {monthGrid(shown.year, shown.month).map((day, index) => {
            if (day === null)
              return <div key={`pad-${index}`} className={`${styles.day} ${styles.pad}`} />
            const entries = plan.days.get(day) ?? []
            const isToday = isThisMonth && day === today.getDate()
            return (
              <button
                key={day}
                type="button"
                role="gridcell"
                className={`${styles.day} ${isPast(day) ? styles.past : ''} ${isToday ? styles.isToday : ''}`}
                aria-pressed={day === chosen}
                aria-label={`${day}, ${entries.length} scheduled`}
                onClick={() => setChosen(day)}
              >
                <span className={styles.n}>{day}</span>
                {entries.slice(0, 2).map((entry) => (
                  <span key={entry.key} className={`${styles.ev} ${entryClass(entry)}`}>
                    {shortTime(entry.at)} {entry.name}
                  </span>
                ))}
                {entries.length > 2 && (
                  <span className={styles.more}>+{entries.length - 2} more</span>
                )}
              </button>
            )
          })}
        </div>

        <aside className={styles.side} aria-label={chosenLabel}>
          <h3>
            {isThisMonth && chosen === today.getDate() ? 'Today · ' : ''}
            {chosenLabel}
          </h3>
          <p className={styles.count}>
            {chosenEntries.length === 0
              ? 'Nothing scheduled.'
              : `${chosenEntries.length} thing${chosenEntries.length === 1 ? '' : 's'}`}
          </p>
          {chosenEntries.map((entry) => {
            return (
              <button
                key={entry.key}
                type="button"
                className={styles.item}
                onClick={() => onOpenTask(entry.taskId)}
              >
                <span className={styles.time}>{formatClock(entry.at)}</span>
                <span>
                  <b>{entry.name}</b>
                  <span className={styles.rec}>{entry.repeats}</span>
                  <span className={`${styles.state} ${styles[`state-${entry.state}`]}`}>
                    {STATE_LABEL[entry.state]}
                  </span>
                </span>
              </button>
            )
          })}
        </aside>
      </div>

      <div className={styles.legend}>
        <span>
          <i className={styles.keyReminder} />
          Reminder
        </span>
        <span>
          <i className={styles.keyTask} />
          Task
        </span>
        <span>
          <i className={styles.keyFailed} />
          Didn&apos;t run
        </span>
        <span>Faded: already happened</span>
      </div>
    </div>
  )
}

function entryClass(entry: MonthEntry): string {
  if (entry.state === 'error' || entry.state === 'stopped') return styles.failed
  return entry.reminder ? styles.reminder : styles.task
}

/** "7 AM", "2:30 PM": a square has room for the hour and little else. */
function shortTime(at: number): string {
  return formatClock(at).replace(/:00(?=\s|$)/, '')
}
