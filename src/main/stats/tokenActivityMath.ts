import type { DailyUsageBucket, ToolUsageCount, UsageInsight, UsageProfile } from '@shared/stats.types'

/**
 * Raw persisted shape `TokenActivityStore` reads/writes — the single source
 * of truth `buildUsageProfile` derives everything else from, so nothing is
 * separately pre-aggregated and liable to drift out of sync.
 */
export interface TokenActivityRecord {
  daily: Record<string, { tokens: number; generations: number }>
  toolUsage: Record<string, number>
  longestGenerationDurationMs: number
  longestGenerationDate: string | null
}

export function emptyTokenActivityRecord(): TokenActivityRecord {
  return { daily: {}, toolUsage: {}, longestGenerationDurationMs: 0, longestGenerationDate: null }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Cap on `UsageProfile.mostUsedTools` — a top-N list, not the full tally. */
const MAX_MOST_USED_TOOLS = 5

/** A 1-day "streak" isn't a notable insight — only surface real multi-day runs. */
const MIN_STREAK_FOR_INSIGHT = 2

/**
 * Whole-day difference between two `YYYY-MM-DD` strings. `Date.parse` treats
 * date-only strings as UTC midnight, so this is exact regardless of the
 * host's timezone or DST — both sides are parsed the same way.
 */
function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / MS_PER_DAY)
}

/**
 * Longest and current consecutive-local-day streaks in `dates` (any order,
 * duplicates allowed), relative to `today`. The current streak counts back
 * from the most recent active day and is 0 once that day is more than one
 * day behind `today` — i.e. activity today or yesterday still counts as
 * "current", two or more silent days resets it.
 */
export function computeStreaks(dates: string[], today: string): { current: number; longest: number } {
  if (dates.length === 0) return { current: 0, longest: 0 }
  const sorted = [...new Set(dates)].sort()

  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    run = daysBetween(sorted[i - 1], sorted[i]) === 1 ? run + 1 : 1
    longest = Math.max(longest, run)
  }

  const mostRecent = sorted[sorted.length - 1]
  if (daysBetween(mostRecent, today) > 1) return { current: 0, longest }

  let current = 1
  for (let i = sorted.length - 1; i > 0; i--) {
    if (daysBetween(sorted[i - 1], sorted[i]) !== 1) break
    current += 1
  }
  return { current, longest }
}

/** Derive the full renderer-facing `UsageProfile` from the raw persisted record. */
export function buildUsageProfile(record: TokenActivityRecord, today: string): UsageProfile {
  const dailyActivity: DailyUsageBucket[] = Object.keys(record.daily)
    .sort()
    .map((date) => ({ date, ...record.daily[date] }))

  const lifetimeTokens = dailyActivity.reduce((sum, day) => sum + day.tokens, 0)
  const lifetimeGenerations = dailyActivity.reduce((sum, day) => sum + day.generations, 0)

  const peakDay = dailyActivity.reduce<DailyUsageBucket | null>(
    (peak, day) => (!peak || day.tokens > peak.tokens ? day : peak),
    null
  )

  const { current: currentStreakDays, longest: longestStreakDays } = computeStreaks(
    Object.keys(record.daily),
    today
  )

  const mostUsedTools: ToolUsageCount[] = Object.entries(record.toolUsage)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, MAX_MOST_USED_TOOLS)

  const insights: UsageInsight[] = []
  if (longestStreakDays >= MIN_STREAK_FOR_INSIGHT) {
    insights.push({ kind: 'streak', days: longestStreakDays })
  }
  if (peakDay) {
    insights.push({ kind: 'busiestDay', date: peakDay.date, tokens: peakDay.tokens })
  }
  if (mostUsedTools.length > 0) {
    insights.push({ kind: 'favoriteTool', name: mostUsedTools[0].name, count: mostUsedTools[0].count })
  }
  if (record.longestGenerationDurationMs > 0) {
    insights.push({ kind: 'longestTask', durationMs: record.longestGenerationDurationMs })
  }

  return {
    lifetimeTokens,
    lifetimeGenerations,
    peakDay: peakDay ? { date: peakDay.date, tokens: peakDay.tokens } : null,
    longestGenerationDurationMs: record.longestGenerationDurationMs,
    currentStreakDays,
    longestStreakDays,
    dailyActivity,
    mostUsedTools,
    insights
  }
}
