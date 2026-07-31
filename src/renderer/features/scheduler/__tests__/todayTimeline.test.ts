import { describe, expect, it } from 'vitest'
import type {
  ScheduledTask,
  ScheduledTaskRunStatus,
  TaskRecurrence,
  TaskRunRecord
} from '@shared/scheduledTask.types'
import { buildTodayTimeline } from '../todayTimeline'

/** Mid-afternoon, so both halves of the day have room in every assertion. */
const NOW = new Date(2026, 6, 23, 14, 10, 0, 0).getTime()
const at = (hour: number, minute = 0): number => new Date(2026, 6, 23, hour, minute, 0, 0).getTime()

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

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const recurrence: TaskRecurrence = { type: 'daily', hour: 18, minute: 0 }
  return {
    id: 'task_1',
    name: 'Daily check-in',
    prompt: 'Summarize the day.',
    projectId: null,
    recurrence,
    enabledTools: [],
    enabled: true,
    conversationId: null,
    createdAt: at(0),
    updatedAt: at(0),
    nextRunAt: at(18),
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    runs: [],
    runCount: 0,
    ...overrides
  }
}

describe('buildTodayTimeline', () => {
  it('places a completed run at its position in the day, carrying its outcome', () => {
    const timeline = buildTodayTimeline([task({ runs: [run('r1', at(6), 'error')] })], NOW)
    const past = timeline.marks.filter((mark) => mark.at < NOW)
    expect(past).toHaveLength(1)
    expect(past[0].kind).toBe('error')
    expect(past[0].position).toBeCloseTo(0.25)
    expect(timeline.failed).toBe(1)
  })

  it('ignores runs from other days', () => {
    const yesterday = at(6) - 86_400_000
    const timeline = buildTodayTimeline([task({ runs: [run('r1', yesterday, 'success')] })], NOW)
    expect(timeline.marks.filter((mark) => mark.kind === 'success')).toHaveLength(0)
  })

  it('marks the soonest run still ahead as the one being waited on', () => {
    const timeline = buildTodayTimeline(
      [
        task({ id: 'a', nextRunAt: at(20) }),
        task({ id: 'b', nextRunAt: at(16), recurrence: { type: 'daily', hour: 16, minute: 0 } })
      ],
      NOW
    )
    const next = timeline.marks.filter((mark) => mark.kind === 'next')
    expect(next).toHaveLength(1)
    expect(next[0].taskId).toBe('b')
  })

  it('projects the rest of the day for a repeating task', () => {
    const timeline = buildTodayTimeline(
      [
        task({
          nextRunAt: at(15),
          recurrence: {
            type: 'interval',
            hour: 0,
            minute: 0,
            every: 2,
            intervalUnit: 'hours',
            anchorAt: at(15)
          }
        })
      ],
      NOW
    )
    // 15:00, 17:00, 19:00, 21:00, 23:00 — and nothing past midnight.
    expect(timeline.upcoming).toBe(5)
    expect(timeline.marks.every((mark) => mark.position < 1)).toBe(true)
  })

  it('fires a once task exactly once rather than repeating it down the day', () => {
    const timeline = buildTodayTimeline(
      [task({ nextRunAt: at(16), recurrence: { type: 'once', hour: 16, minute: 0 } })],
      NOW
    )
    expect(timeline.upcoming).toBe(1)
  })

  it('caps a very frequent task instead of burying the track', () => {
    const timeline = buildTodayTimeline(
      [
        task({
          nextRunAt: at(14, 15),
          recurrence: {
            type: 'interval',
            hour: 0,
            minute: 0,
            every: 5,
            intervalUnit: 'minutes',
            anchorAt: at(0)
          }
        })
      ],
      NOW
    )
    expect(timeline.upcoming).toBe(24)
  })

  it('draws nothing ahead of now for a paused task, but keeps what it already ran', () => {
    const timeline = buildTodayTimeline(
      [task({ enabled: false, nextRunAt: null, runs: [run('r1', at(9), 'success')] })],
      NOW
    )
    expect(timeline.upcoming).toBe(0)
    expect(timeline.completed).toBe(1)
  })

  it('places now within the day', () => {
    const timeline = buildTodayTimeline([], NOW)
    expect(timeline.nowPosition).toBeCloseTo((14 * 60 + 10) / 1440, 4)
    expect(timeline.marks).toHaveLength(0)
  })

  it('orders marks by time so the track reads left to right', () => {
    const timeline = buildTodayTimeline(
      [
        task({ id: 'a', nextRunAt: at(20), runs: [run('r2', at(11), 'success')] }),
        task({ id: 'b', nextRunAt: at(16), runs: [run('r1', at(3), 'success')] })
      ],
      NOW
    )
    const times = timeline.marks.map((mark) => mark.at)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})
