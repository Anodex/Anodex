import { describe, expect, it } from 'vitest'
import type {
  ScheduledTask,
  ScheduledTaskRunStatus,
  TaskRecurrence,
  TaskRunRecord
} from '../scheduledTask.types'
import { buildMonth, frequentCadence, monthForWire, monthGrid } from '../scheduleMonth'

/** Monday 12 October 2026, early afternoon. */
const NOW = new Date(2026, 9, 12, 13, 0).getTime()
const on = (day: number, hour = 9, minute = 0): number =>
  new Date(2026, 9, day, hour, minute).getTime()

function run(id: string, startedAt: number, status: ScheduledTaskRunStatus): TaskRunRecord {
  return {
    id,
    startedAt,
    durationMs: 1000,
    status,
    summary: null,
    messageId: null,
    userMessageId: null,
    delayedMs: 0,
    skippedSlots: 0,
    fabricationDetected: false
  }
}

function task(recurrence: TaskRecurrence, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task_1',
    name: 'Weekly review',
    prompt: 'Review the week.',
    projectId: null,
    recurrence,
    enabledTools: [],
    enabled: true,
    conversationId: null,
    createdAt: on(1),
    updatedAt: on(1),
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    runs: [],
    runCount: 0,
    ...overrides
  }
}

describe('buildMonth', () => {
  it('puts a weekly task on each of its days still to come, and its past runs as they went', () => {
    const friday = task(
      { type: 'weekly', hour: 16, minute: 0, weekdays: [5] },
      {
        nextRunAt: on(16, 16),
        runs: [run('r1', on(9, 16), 'error'), run('r2', on(2, 16), 'success')]
      }
    )
    const month = buildMonth([friday], 2026, 9, NOW)
    expect(month.days.get(2)?.[0].state).toBe('success')
    expect(month.days.get(9)?.[0].state).toBe('error')
    expect([...month.days.keys()].sort((a, b) => a - b)).toEqual([2, 9, 16, 23, 30])
    expect(month.days.get(23)?.[0].state).toBe('upcoming')
    expect(month.every).toHaveLength(0)
  })

  it('says a daily task once, above the calendar, instead of on every square', () => {
    const daily = task(
      { type: 'daily', hour: 18, minute: 0 },
      { name: 'Water the plants', kind: 'reminder', nextRunAt: on(12, 18) }
    )
    const month = buildMonth([daily], 2026, 9, NOW)
    expect(month.days.size).toBe(0)
    expect(month.every).toEqual([
      expect.objectContaining({
        name: 'Water the plants',
        cadence: 'Every day',
        hour: 18,
        reminder: true
      })
    ])
    // Still listed when a day is opened.
    expect(month.everyByDay.get(20)?.[0].name).toBe('Water the plants')
  })

  it('shows a one-off once, and nothing ahead for a paused task', () => {
    const once = task(
      { type: 'once', hour: 14, minute: 30, runAt: on(20, 14, 30) },
      { nextRunAt: on(20, 14, 30) }
    )
    const paused = task(
      { type: 'weekly', hour: 7, minute: 0, weekdays: [2] },
      { id: 'p', enabled: false, nextRunAt: null }
    )
    const month = buildMonth([once, paused], 2026, 9, NOW)
    expect([...month.days.keys()]).toEqual([20])
  })
})

describe('frequentCadence', () => {
  it('names weekdays and intervals, and leaves the rest to their days', () => {
    expect(
      frequentCadence(task({ type: 'weekly', hour: 8, minute: 0, weekdays: [1, 2, 3, 4, 5] }))
    ).toBe('Weekdays')
    expect(
      frequentCadence(
        task({ type: 'interval', hour: 0, minute: 0, every: 2, intervalUnit: 'hours' })
      )
    ).toBe('Every 2 hours')
    expect(
      frequentCadence(task({ type: 'weekly', hour: 8, minute: 0, weekdays: [2, 4] }))
    ).toBeNull()
    expect(frequentCadence(task({ type: 'monthly', hour: 9, minute: 0, dayOfMonth: 1 }))).toBeNull()
  })
})

describe('monthGrid', () => {
  it('starts on Monday and pads to whole weeks', () => {
    const grid = monthGrid(2026, 9)
    // 1 October 2026 is a Thursday: three blank squares first.
    expect(grid.slice(0, 4)).toEqual([null, null, null, 1])
    expect(grid.length % 7).toBe(0)
    expect(grid.filter((d) => d !== null)).toHaveLength(31)
  })
})

describe('monthForWire', () => {
  it('flattens the month into plain arrays, in day order, with how each task repeats', () => {
    const friday = task(
      { type: 'weekly', hour: 16, minute: 0, weekdays: [5] },
      { nextRunAt: on(16, 16) }
    )
    const wire = monthForWire(buildMonth([friday], 2026, 9, NOW), 2026, 9)
    expect(wire.days.map((d) => d.day)).toEqual([16, 23, 30])
    expect(wire.days[0].entries[0].repeats).toBe('Every Fri at 4:00 PM')
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire)
  })
})
