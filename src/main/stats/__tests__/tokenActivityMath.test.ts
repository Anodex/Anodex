import { describe, expect, it } from 'vitest'
import { buildUsageProfile, computeStreaks, emptyTokenActivityRecord } from '../tokenActivityMath'
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
      insights: []
    })
  })

  it('sums lifetime totals and identifies the peak day', () => {
    const record: TokenActivityRecord = {
      daily: {
        '2026-07-01': { tokens: 100, generations: 2 },
        '2026-07-02': { tokens: 500, generations: 5 }
      },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null
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
      longestGenerationDate: null
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
      daily: { '2026-07-05': { tokens: 10, generations: 1 } },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null
    }
    expect(buildUsageProfile(oneDayRecord, '2026-07-05').insights).toEqual([
      { kind: 'busiestDay', date: '2026-07-05', tokens: 10 }
    ])

    const twoDayRecord: TokenActivityRecord = {
      daily: {
        '2026-07-04': { tokens: 10, generations: 1 },
        '2026-07-05': { tokens: 10, generations: 1 }
      },
      toolUsage: {},
      longestGenerationDurationMs: 0,
      longestGenerationDate: null
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
      longestGenerationDate: '2026-07-01'
    }
    const profile = buildUsageProfile(record, '2026-07-05')
    expect(profile.insights).toContainEqual({ kind: 'favoriteTool', name: 'read_file', count: 3 })
    expect(profile.insights).toContainEqual({ kind: 'longestTask', durationMs: 45_000 })
  })
})
