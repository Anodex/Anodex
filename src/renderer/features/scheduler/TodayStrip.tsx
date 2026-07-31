import { useEffect, useState } from 'react'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import { buildTodayTimeline } from './todayTimeline'
import styles from './TodayStrip.module.css'

/** Ticks marked on the track, and which of them are labelled. */
const TICK_HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24]
const LABELLED_HOURS = new Set([0, 6, 12, 18, 24])

function hourLabel(hour: number): string {
  if (hour === 0 || hour === 24) return '12a'
  if (hour === 12) return '12p'
  return hour > 12 ? `${hour - 12}p` : `${hour}a`
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * Re-renders once a minute so the `now` marker keeps up with the clock. This is
 * data moving, not an animation — on a track this wide a minute is well under a
 * pixel, so nothing visibly slides.
 */
function useMinuteTick(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 60_000)
    return () => clearInterval(timer)
  }, [])
}

/**
 * The day as one track: what already ran, how it went, and what's still coming.
 *
 * The task list can't answer "what is my day going to do?" at any length — it's
 * sorted by next run, and that ordering is the only hint that time is involved
 * at all. This turns the abstraction into a shape.
 */
export function TodayStrip({ tasks }: { tasks: ScheduledTask[] }): JSX.Element | null {
  useMinuteTick()
  // Rebuilt every render rather than memoised on `tasks`: the minute tick has
  // to be able to move `now`, and memoising on the task list alone would freeze
  // the marker in place. The projection is a few dozen date additions over a
  // list that is never long.
  const timeline = buildTodayTimeline(tasks)

  if (timeline.marks.length === 0) return null

  const summary = [
    timeline.completed > 0 ? `${timeline.completed} done` : null,
    timeline.failed > 0 ? `${timeline.failed} failed` : null,
    timeline.upcoming > 0 ? `${timeline.upcoming} still to run` : null
  ].filter(Boolean)

  return (
    <section className={styles.strip} aria-label="Today's scheduled runs">
      <div className={styles.head}>
        <span className={styles.title}>Today</span>
        <span className={styles.summary}>{summary.join(' · ')}</span>
      </div>
      <div className={styles.track}>
        <div className={styles.line} />
        <div className={styles.past} style={{ width: `${timeline.nowPosition * 100}%` }} />
        {TICK_HOURS.map((hour) => (
          <div key={hour} className={styles.tick} style={{ left: `${(hour / 24) * 100}%` }}>
            {LABELLED_HOURS.has(hour) && (
              <span className={styles.tickLabel}>{hourLabel(hour)}</span>
            )}
          </div>
        ))}
        {timeline.marks.map((mark) => (
          <span
            key={mark.key}
            className={`${styles.pip} ${styles[`pip-${mark.kind}`]}`}
            style={{ left: `${mark.position * 100}%` }}
            title={`${mark.taskName} — ${timeLabel(mark.at)}`}
          >
            <i />
          </span>
        ))}
        <div className={styles.now} style={{ left: `${timeline.nowPosition * 100}%` }}>
          <span className={styles.nowLabel}>now</span>
        </div>
      </div>
    </section>
  )
}
