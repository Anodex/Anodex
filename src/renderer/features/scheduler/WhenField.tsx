import { useEffect, useMemo, useState } from 'react'
import type { IntervalUnit, RecurrenceType, TaskRecurrence } from '@shared/scheduledTask.types'
import { MIN_INTERVAL_MINUTES } from '@shared/scheduledTask.types'
import { describeRecurrence, parseWhen } from '@shared/parseWhen'
import { computeNextRunAt } from '@shared/nextRun'
import { Icon } from '../../components/Icon'
import { SelectControl } from '../settings/controls'
import { formatNextRun } from './scheduleFormat'
import { useCountdown } from './useCountdown'
import styles from './WhenField.module.css'

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEKDAYS_PRESET = [1, 2, 3, 4, 5]
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The monthly "which day" choices. `day` means a date, the rest are the
 * `weekOfMonth` values for "the first/second/... Friday", with -1 for last.
 */
const MONTH_DAY_MODES = [
  { label: 'on day', value: 'day' },
  { label: 'on the first', value: '1' },
  { label: 'on the second', value: '2' },
  { label: 'on the third', value: '3' },
  { label: 'on the fourth', value: '4' },
  { label: 'on the last', value: '-1' }
]

/** One-tap starting points, covering the shapes people reach for most. */
const PRESETS = [
  'in 10 minutes',
  'every 30 minutes',
  'hourly',
  'every day at 9am',
  'weekdays at 5pm',
  'the 1st of every month at 9am'
]

interface WhenFieldProps {
  value: TaskRecurrence
  onChange: (recurrence: TaskRecurrence) => void
  /** Raw text the user typed, lifted so the editor can keep it across re-renders. */
  text: string
  onTextChange: (text: string) => void
}

function timeToInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function inputToTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map((part) => Number(part))
  return { hour: hour || 0, minute: minute || 0 }
}

/**
 * The primary "when should this run?" control: a single field you type a
 * schedule into the way you'd say it, with a live preview of how it was read
 * and when it fires next.
 *
 * The exact controls it replaces are still here, one disclosure down, kept in
 * sync with whatever the text parsed to — the text field is a faster front
 * door, not a replacement for being able to say precisely what you mean.
 */
export function WhenField({ value, onChange, text, onTextChange }: WhenFieldProps): JSX.Element {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const parsed = useMemo(() => parseWhen(text), [text])
  // The preview counts down live, same as the task cards.
  const nextRunAt = useMemo(() => computeNextRunAt(value, Date.now(), false), [value])
  useCountdown(nextRunAt)

  // Push a successful parse up to the editor. Guarded on the described rule
  // rather than object identity, since `parseWhen` builds a fresh object on
  // every keystroke and would otherwise loop.
  const parsedDescription = parsed ? describeRecurrence(parsed.recurrence) : null
  const currentDescription = describeRecurrence(value)
  useEffect(() => {
    if (parsed && parsedDescription !== currentDescription) onChange(parsed.recurrence)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedDescription])

  const patchRecurrence = (patch: Partial<TaskRecurrence>): void => {
    const next = { ...value, ...patch }
    onChange(next)
    // Keep the text field showing the rule the controls now describe, so the
    // two halves of this component can never disagree about the schedule.
    onTextChange(describeRecurrence(next))
  }

  const toggleWeekday = (day: number): void => {
    const weekdays = value.weekdays ?? []
    patchRecurrence({
      weekdays: weekdays.includes(day)
        ? weekdays.filter((d) => d !== day)
        : [...weekdays, day].sort()
    })
  }

  const showTime = value.type !== 'interval' && value.runAt === undefined
  const unparsed = text.trim().length > 0 && !parsed

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor="when-input">
        When should this run?
      </label>

      <input
        id="when-input"
        className={styles.input}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        placeholder="every 30 minutes · in 10 minutes · weekdays at 5pm"
        autoComplete="off"
        spellCheck={false}
      />

      <div className={styles.presets}>
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={styles.preset}
            onClick={() => onTextChange(preset)}
          >
            {preset}
          </button>
        ))}
      </div>

      <div
        className={`${styles.preview} ${unparsed ? styles.previewUnparsed : ''}`}
        aria-live="polite"
      >
        <Icon
          name={unparsed ? 'alert' : 'check'}
          size={14}
          className={unparsed ? styles.previewIconWarn : styles.previewIconOk}
        />
        <div className={styles.previewBody}>
          {unparsed ? (
            <>
              <span className={styles.previewMain}>Couldn&apos;t read that as a time</span>
              <span className={styles.previewSub}>
                Try &ldquo;every 30 minutes&rdquo;, &ldquo;in 10 minutes&rdquo;, or set it exactly
                below. The schedule below is unchanged.
              </span>
            </>
          ) : (
            <>
              <span className={styles.previewMain}>{describeRecurrence(value)}</span>
              <span className={styles.previewSub}>
                {nextRunAt === null
                  ? 'Pick at least one day for this to run.'
                  : `Next run ${new Date(nextRunAt).toLocaleString(undefined, {
                      weekday: nextRunAt - Date.now() > 86_400_000 ? 'short' : undefined,
                      hour: 'numeric',
                      minute: '2-digit'
                    })} · ${formatNextRun(nextRunAt).toLowerCase()}`}
              </span>
              {parsed?.note && <span className={styles.previewNote}>{parsed.note}</span>}
            </>
          )}
        </div>
      </div>

      <button
        type="button"
        className={styles.advancedToggle}
        onClick={() => setAdvancedOpen((open) => !open)}
        aria-expanded={advancedOpen}
      >
        <Icon
          name="chevron-right"
          size={12}
          className={`${styles.chevron} ${advancedOpen ? styles.chevronOpen : ''}`}
        />
        Set it exactly
      </button>

      {advancedOpen && (
        <div className={styles.advanced}>
          <div className={styles.advancedRow}>
            <SelectControl
              value={value.type}
              onChange={(next) => {
                const type = next as RecurrenceType
                patchRecurrence({
                  type,
                  // A relative one-shot's absolute instant is meaningless once
                  // the rule becomes a repeat, so drop it rather than carry it.
                  runAt: undefined,
                  weekdays:
                    type === 'weekly' ? (value.weekdays ?? WEEKDAYS_PRESET) : value.weekdays,
                  every: type === 'interval' ? (value.every ?? 30) : value.every,
                  intervalUnit:
                    type === 'interval' ? (value.intervalUnit ?? 'minutes') : value.intervalUnit,
                  anchorAt: type === 'interval' ? Date.now() : undefined,
                  // A monthly rule that names no day can never fire, so it
                  // opens on today's date rather than on nothing.
                  dayOfMonth:
                    type === 'monthly'
                      ? (value.dayOfMonth ?? new Date().getDate())
                      : value.dayOfMonth,
                  weekOfMonth: type === 'monthly' ? value.weekOfMonth : undefined
                })
              }}
              options={[
                { label: 'Once', value: 'once' },
                { label: 'Every day', value: 'daily' },
                { label: 'Certain days', value: 'weekly' },
                { label: 'Monthly', value: 'monthly' },
                { label: 'On a repeat', value: 'interval' }
              ]}
            />

            {value.type === 'interval' ? (
              <>
                <span className={styles.intervalWord}>every</span>
                <input
                  type="number"
                  min={value.intervalUnit === 'minutes' ? MIN_INTERVAL_MINUTES : 1}
                  className={styles.intervalNumber}
                  value={value.every ?? 30}
                  onChange={(event) =>
                    patchRecurrence({ every: Math.max(1, Number(event.target.value) || 1) })
                  }
                />
                <SelectControl
                  value={value.intervalUnit ?? 'minutes'}
                  onChange={(next) => patchRecurrence({ intervalUnit: next as IntervalUnit })}
                  options={[
                    { label: 'minutes', value: 'minutes' },
                    { label: 'hours', value: 'hours' },
                    { label: 'days', value: 'days' }
                  ]}
                />
              </>
            ) : null}

            {value.type === 'monthly' ? (
              <>
                <SelectControl
                  value={value.weekOfMonth === undefined ? 'day' : String(value.weekOfMonth)}
                  onChange={(next) =>
                    next === 'day'
                      ? patchRecurrence({
                          weekOfMonth: undefined,
                          dayOfMonth: value.dayOfMonth ?? new Date().getDate()
                        })
                      : patchRecurrence({
                          weekOfMonth: Number(next),
                          dayOfMonth: undefined,
                          // The ordinal form reads `weekdays[0]`, so it needs a
                          // day even when switching over from a date.
                          weekdays: [value.weekdays?.[0] ?? 1]
                        })
                  }
                  options={MONTH_DAY_MODES}
                />
                {value.weekOfMonth === undefined ? (
                  <input
                    type="number"
                    min={1}
                    max={31}
                    className={styles.intervalNumber}
                    value={value.dayOfMonth ?? 1}
                    onChange={(event) =>
                      patchRecurrence({
                        dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value) || 1))
                      })
                    }
                  />
                ) : (
                  <SelectControl
                    value={String(value.weekdays?.[0] ?? 1)}
                    onChange={(next) => patchRecurrence({ weekdays: [Number(next)] })}
                    options={WEEKDAY_NAMES.map((label, day) => ({
                      label,
                      value: String(day)
                    }))}
                  />
                )}
              </>
            ) : null}

            {showTime && (
              <input
                type="time"
                className={styles.timeInput}
                value={timeToInput(value.hour, value.minute)}
                onChange={(event) => patchRecurrence(inputToTime(event.target.value))}
              />
            )}
          </div>

          {value.type === 'interval' &&
            value.intervalUnit === 'minutes' &&
            (value.every ?? 0) < MIN_INTERVAL_MINUTES && (
              <p className={styles.hint}>
                Repeats are capped at {MIN_INTERVAL_MINUTES} minutes. For a single reminder sooner
                than that, type &ldquo;in 1 minute&rdquo; above.
              </p>
            )}

          {value.type === 'weekly' && (
            <div className={styles.weekdays}>
              {WEEKDAY_LABELS.map((label, day) => (
                <button
                  key={day}
                  type="button"
                  className={`${styles.weekday} ${
                    (value.weekdays ?? []).includes(day) ? styles.weekdaySelected : ''
                  }`}
                  onClick={() => toggleWeekday(day)}
                  aria-pressed={(value.weekdays ?? []).includes(day)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
