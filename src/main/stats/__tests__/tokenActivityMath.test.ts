import { describe, expect, it } from 'vitest'
import {
  buildChartBuckets,
  buildModelBreakdown,
  buildUsageProfile,
  computeStreaks,
  emptyTokenActivityRecord
} from '../tokenActivityMath'
import type { TokenActivityRecord } from '../tokenActivityMath'

describe('computeStreaks', () => {
  it('returns zero for no activity', () => {
    expect(computeStreaks([], '2026-07-05')).toEqual({ current: 0, longest: 0 })
  })

  it('counts a single active day as a streak of one, current if it is today', () => {
    expect(computeStreaks(['2026-07-05'], '2026-07-05')).toEqual({ current: 1, longest: 1 })
  })

  it('finds a consecutive run and treats it as current when it ends today', () => {
    const dates = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']
    expect(computeStreaks(dates, '2026-07-05')).toEqual({ current: 5, longest: 5 })
  })

  it('still counts yesterday-ending activity as the current streak', () => {
    const dates = ['2026-07-03', '2026-07-04']
    expect(computeStreaks(dates, '2026-07-05')).toEqual({ current: 2, longest: 2 })
  })

  it('resets current to zero once the gap since the last active day exceeds one day', () => {
    const dates = ['2026-07-01', '2026-07-02', '2026-07-03']
    expect(computeStreaks(dates, '2026-07-06')).toEqual({ current: 0, longest: 3 })
  })

  it('keeps the longest historical run even after the streak has since broken', () => {
    const dates = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-07-05']
    expect(computeStreaks(dates, '2026-07-05')).toEqual({ current: 1, longest: 4 })
  })

  it('deduplicates repeated dates instead of inflating the streak', () => {
    const dates = ['2026-07-05', '2026-07-05', '2026-07-04']
    expect(computeStreaks(dates, '2026-07-05')).toEqual({ current: 2, longest: 2 })
  })
})

describe('buildUsageProfile', () => {
  it('returns an all-zero profile with no insights for an empty record', () => {
    const profile = buildUsageProfile(emptyTokenActivityRecord(), '2026-07-05')
    expect(profile).toEqual({
      lifetimeTokens: 0,
      lifetimeGenerations: 0,
      peakDay: null,
      longestGenerationDurationMs: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      dailyActivity: [],
      mostUsedTools: [],
      insights: [],
      sessionCount: 0,
      peakHour: null,
      favoriteModel: null
    })
  })

  it('sums lifetime totals and identifies the peak day', () => {
    const record: TokenActivityRecord = {
      daily: {
        '2026-07-01': { tokens: 100, generations: 2, models: {} },
        '2026-07-02': { tokens: 500, generations: 5, models: {} }
      },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: {},
      sessionIds: []
    }
    const profile = buildUsageProfile(record, '2026-07-02')
    expect(profile.lifetimeTokens).toBe(600)
    expect(profile.lifetimeGenerations).toBe(7)
    expect(profile.peakDay).toEqual({ date: '2026-07-02', tokens: 500 })
    expect(profile.dailyActivity).toEqual([
      { date: '2026-07-01', tokens: 100, generations: 2 },
      { date: '2026-07-02', tokens: 500, generations: 5 }
    ])
  })

  it('ranks most-used tools by count descending, capped at 5, ties broken by name', () => {
    const record: TokenActivityRecord = {
      daily: {},
      toolUsage: {
        write_file: 10,
        read_file: 20,
        run_command: 5,
        search_files: 5,
        git_status: 1,
        list_directory: 1
      },
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: {},
      sessionIds: []
    }
    const profile = buildUsageProfile(record, '2026-07-05')
    expect(profile.mostUsedTools).toEqual([
      { name: 'read_file', count: 20 },
      { name: 'write_file', count: 10 },
      { name: 'run_command', count: 5 },
      { name: 'search_files', count: 5 },
      { name: 'git_status', count: 1 }
    ])
  })

  it('only surfaces a streak insight for runs of two or more days', () => {
    const oneDayRecord: TokenActivityRecord = {
      daily: { '2026-07-05': { tokens: 10, generations: 1, models: {} } },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: {},
      sessionIds: []
    }
    expect(buildUsageProfile(oneDayRecord, '2026-07-05').insights).toEqual([
      { kind: 'busiestDay', date: '2026-07-05', tokens: 10 }
    ])

    const twoDayRecord: TokenActivityRecord = {
      daily: {
        '2026-07-04': { tokens: 10, generations: 1, models: {} },
        '2026-07-05': { tokens: 10, generations: 1, models: {} }
      },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: {},
      sessionIds: []
    }
    expect(buildUsageProfile(twoDayRecord, '2026-07-05').insights).toContainEqual({
      kind: 'streak',
      days: 2
    })
  })

  it('includes favoriteTool and longestTask insights when present', () => {
    const record: TokenActivityRecord = {
      daily: {},
      toolUsage: { read_file: 3 },
      longestGenerationDurationMs: 45_000,
      longestGenerationDate: '2026-07-01',
      hourly: {},
      sessionIds: []
    }
    const profile = buildUsageProfile(record, '2026-07-05')
    expect(profile.insights).toContainEqual({ kind: 'favoriteTool', name: 'read_file', count: 3 })
    expect(profile.insights).toContainEqual({ kind: 'longestTask', durationMs: 45_000 })
  })

  it('includes a referenceBook insight once lifetime tokens round to at least 1x, not before', () => {
    const belowThreshold: TokenActivityRecord = {
      daily: { '2026-07-05': { tokens: 100_000, generations: 1, models: {} } },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: {},
      sessionIds: []
    }
    expect(buildUsageProfile(belowThreshold, '2026-07-05').insights).not.toContainEqual(
      expect.objectContaining({ kind: 'referenceBook' })
    )

    const aboveThreshold: TokenActivityRecord = {
      daily: { '2026-07-05': { tokens: 267_800 * 3, generations: 1, models: {} } },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: {},
      sessionIds: []
    }
    expect(buildUsageProfile(aboveThreshold, '2026-07-05').insights).toContainEqual({
      kind: 'referenceBook',
      multiplier: 3,
      bookTitle: 'Moby-Dick'
    })
  })

  it('reports sessionCount, peakHour, and favoriteModel', () => {
    const record: TokenActivityRecord = {
      daily: {
        '2026-07-05': {
          tokens: 300,
          generations: 2,
          models: {
            'model-a': { modelName: 'Model A', inputTokens: 50, outputTokens: 100 },
            'model-b': { modelName: 'Model B', inputTokens: 10, outputTokens: 20 }
          }
        }
      },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: { '9': 1, '14': 3, '20': 2 },
      sessionIds: ['conv-1', 'conv-2']
    }
    const profile = buildUsageProfile(record, '2026-07-05')
    expect(profile.sessionCount).toBe(2)
    expect(profile.peakHour).toBe(14)
    expect(profile.favoriteModel).toEqual({
      modelId: 'model-a',
      modelName: 'Model A',
      inputTokens: 50,
      outputTokens: 100,
      share: 150 / 180
    })
  })
})

describe('buildModelBreakdown', () => {
  it('returns an empty list for a record with no model activity', () => {
    expect(buildModelBreakdown(emptyTokenActivityRecord())).toEqual([])
  })

  it('sums per-model input/output across days, sorted by combined total descending', () => {
    const record: TokenActivityRecord = {
      daily: {
        '2026-07-01': {
          tokens: 0,
          generations: 0,
          models: { a: { modelName: 'Alpha', inputTokens: 10, outputTokens: 10 } }
        },
        '2026-07-02': {
          tokens: 0,
          generations: 0,
          models: {
            a: { modelName: 'Alpha', inputTokens: 5, outputTokens: 5 },
            b: { modelName: 'Beta', inputTokens: 100, outputTokens: 100 }
          }
        }
      },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: {},
      sessionIds: []
    }
    const breakdown = buildModelBreakdown(record)
    expect(breakdown[0]).toEqual({
      modelId: 'b',
      modelName: 'Beta',
      inputTokens: 100,
      outputTokens: 100,
      share: 200 / 230
    })
    expect(breakdown[1]).toEqual({
      modelId: 'a',
      modelName: 'Alpha',
      inputTokens: 15,
      outputTokens: 15,
      share: 30 / 230
    })
  })

  it('breaks a tie in combined tokens by model name', () => {
    const record: TokenActivityRecord = {
      daily: {
        '2026-07-01': {
          tokens: 0,
          generations: 0,
          models: {
            zeta: { modelName: 'Zeta', inputTokens: 5, outputTokens: 5 },
            alpha: { modelName: 'Alpha', inputTokens: 5, outputTokens: 5 }
          }
        }
      },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: {},
      sessionIds: []
    }
    const breakdown = buildModelBreakdown(record)
    expect(breakdown.map((m) => m.modelName)).toEqual(['Alpha', 'Zeta'])
  })
})

describe('buildChartBuckets', () => {
  const record: TokenActivityRecord = {
    daily: {
      '2026-06-01': { tokens: 0, generations: 0, models: { a: { modelName: 'A', inputTokens: 10, outputTokens: 0 } } },
      '2026-06-29': { tokens: 0, generations: 0, models: { a: { modelName: 'A', inputTokens: 20, outputTokens: 0 } } },
      '2026-06-30': { tokens: 0, generations: 0, models: { a: { modelName: 'A', inputTokens: 5, outputTokens: 0 } } },
      '2026-07-05': { tokens: 0, generations: 0, models: { a: { modelName: 'A', inputTokens: 100, outputTokens: 0 } } }
    },
    toolUsage: {},
    longestGenerationDurationMs: 0,
    longestGenerationDate: null,
    hourly: {},
    sessionIds: []
  }

  it('daily granularity returns one bucket per day, filtered to the range', () => {
    const buckets = buildChartBuckets(record, '7d', 'daily', '2026-07-05')
    expect(buckets).toEqual([
      { key: '2026-06-29', byModel: { a: 20 }, total: 20 },
      { key: '2026-06-30', byModel: { a: 5 }, total: 5 },
      { key: '2026-07-05', byModel: { a: 100 }, total: 100 }
    ])
  })

  it('a day exactly N days ago is excluded from the N-day range (exclusive boundary)', () => {
    // 2026-06-05 is exactly 30 days before 2026-07-05 — must NOT appear in '30d'.
    const boundaryRecord: TokenActivityRecord = {
      daily: {
        '2026-06-05': { tokens: 0, generations: 0, models: { a: { modelName: 'A', inputTokens: 1, outputTokens: 0 } } },
        '2026-06-06': { tokens: 0, generations: 0, models: { a: { modelName: 'A', inputTokens: 2, outputTokens: 0 } } }
      },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null,
      hourly: {},
      sessionIds: []
    }
    const buckets = buildChartBuckets(boundaryRecord, '30d', 'daily', '2026-07-05')
    expect(buckets.map((b) => b.key)).toEqual(['2026-06-06'])
  })

  it('"all" range includes every recorded day', () => {
    const buckets = buildChartBuckets(record, 'all', 'daily', '2026-07-05')
    expect(buckets.map((b) => b.key)).toEqual(['2026-06-01', '2026-06-29', '2026-06-30', '2026-07-05'])
  })

  it('weekly granularity groups by Sunday-start week, even across a month boundary', () => {
    // 2026-06-29 is a Monday, 2026-06-30 a Tuesday — both fall in the week starting Sun 2026-06-28.
    const buckets = buildChartBuckets(record, 'all', 'weekly', '2026-07-05')
    const juneWeek = buckets.find((b) => b.key === '2026-06-28')
    expect(juneWeek).toEqual({ key: '2026-06-28', byModel: { a: 25 }, total: 25 })
  })

  it('cumulative granularity runs a per-model and total running sum', () => {
    const buckets = buildChartBuckets(record, 'all', 'cumulative', '2026-07-05')
    expect(buckets.map((b) => b.total)).toEqual([10, 30, 35, 135])
    expect(buckets[buckets.length - 1].byModel).toEqual({ a: 135 })
  })
})
