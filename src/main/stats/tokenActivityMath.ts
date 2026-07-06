import type {
  ChartBucket,
  ChartGranularity,
  ChartRange,
  DailyUsageBucket,
  ModelUsageBreakdown,
  ToolUsageCount,
  UsageInsight,
  UsageProfile
} from '@shared/stats.types'

/**
 * Raw persisted shape `TokenActivityStore` reads/writes — the single source
 * of truth `buildUsageProfile`/`buildModelBreakdown`/`buildChartBuckets`
 * derive everything else from, so nothing is separately pre-aggregated and
 * liable to drift out of sync.
 */
export interface TokenActivityRecord {
  daily: Record<
    string,
    {
      tokens: number
      generations: number
      /** Per-model split for this day, keyed by `ModelInfo.id`. */
      models: Record<string, { modelName: string; inputTokens: number; outputTokens: number }>
    }
  >
  toolUsage: Record<string, number>
  longestGenerationDurationMs: number
  longestGenerationDate: string | null
  /**
   * Lifetime-only generation-count-per-local-hour tally, keys `'0'`..`'23'`.
   * Deliberately not tracked per-day (a days×24 matrix) — "peak hour" is a
   * lifetime insight here, not something the time-range chart filter needs
   * to slice.
   */
  hourly: Record<string, number>
  /**
   * Every conversationId ever recorded against. A Set persisted as an array
   * (JSON has no Set type) so a conversation's later turns don't
   * double-count as new sessions.
   */
  sessionIds: string[]
}

export function emptyTokenActivityRecord(): TokenActivityRecord {
  return {
    daily: {},
    toolUsage: {},
    longestGenerationDurationMs: 0,
    longestGenerationDate: null,
    hourly: {},
    sessionIds: []
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Cap on `UsageProfile.mostUsedTools` — a top-N list, not the full tally. */
const MAX_MOST_USED_TOOLS = 5

/** A 1-day "streak" isn't a notable insight — only surface real multi-day runs. */
const MIN_STREAK_FOR_INSIGHT = 2

/**
 * ~206,000 words × ~1.3 tokens/word, a standard rough English BPE ratio —
 * a fun approximation for the "you've used Nx more tokens than ___" insight,
 * not a real tokenization of the actual text.
 */
const MOBY_DICK_APPROX_TOKENS = 267_800

/**
 * Whole-day difference between two `YYYY-MM-DD` strings. `Date.parse` treats
 * date-only strings as UTC midnight, so this is exact regardless of the
 * host's timezone or DST — both sides are parsed the same way.
 */
function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / MS_PER_DAY)
}

/**
 * Parses a `YYYY-MM-DD` string via the local-time `Date` constructor (not
 * `Date.parse`, which reads it as UTC) — needed specifically for `.getDay()`
 * (weekday), since calling that on a UTC-midnight-parsed `Date` can read
 * back the wrong local weekday for users west of UTC.
 */
function parseLocalDateOnly(dateString: string): Date {
  const [year, month, day] = dateString.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function toLocalDateOnlyString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The Sunday on/before `dateString` — matches `UsageHeatmap`'s own Sunday-start week convention. */
function startOfWeek(dateString: string): string {
  const date = parseLocalDateOnly(dateString)
  date.setDate(date.getDate() - date.getDay())
  return toLocalDateOnlyString(date)
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

/** The local hour (0-23) with the most generations, lifetime; `null` if there's no activity yet. */
function computePeakHour(hourly: Record<string, number>): number | null {
  const entries = Object.entries(hourly)
  if (entries.length === 0) return null
  const [peakHour] = entries.reduce((max, entry) => (entry[1] > max[1] ? entry : max))
  return Number(peakHour)
}

/**
 * Lifetime per-model input/output token totals, sorted by combined tokens
 * descending (ties broken by name, matching `mostUsedTools`'s tie-break).
 */
export function buildModelBreakdown(record: TokenActivityRecord): ModelUsageBreakdown[] {
  const totals = new Map<string, { modelName: string; inputTokens: number; outputTokens: number }>()
  for (const day of Object.values(record.daily)) {
    for (const [modelId, modelDay] of Object.entries(day.models ?? {})) {
      const existing = totals.get(modelId) ?? {
        modelName: modelDay.modelName,
        inputTokens: 0,
        outputTokens: 0
      }
      existing.inputTokens += modelDay.inputTokens
      existing.outputTokens += modelDay.outputTokens
      existing.modelName = modelDay.modelName
      totals.set(modelId, existing)
    }
  }

  const lifetimeCombined = [...totals.values()].reduce(
    (sum, m) => sum + m.inputTokens + m.outputTokens,
    0
  )

  return [...totals.entries()]
    .map(([modelId, m]) => ({
      modelId,
      modelName: m.modelName,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      share: lifetimeCombined > 0 ? (m.inputTokens + m.outputTokens) / lifetimeCombined : 0
    }))
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
        a.modelName.localeCompare(b.modelName)
    )
}

/**
 * Chart-ready buckets for the token-activity chart: filtered to `range`,
 * grouped by `granularity`. `daily` returns one bucket per day; `weekly`
 * groups into Sunday-start weeks; `cumulative` returns a running per-model
 * sum across the (daily-granularity) sequence.
 */
export function buildChartBuckets(
  record: TokenActivityRecord,
  range: ChartRange,
  granularity: ChartGranularity,
  today: string
): ChartBucket[] {
  const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : Infinity
  const dates = Object.keys(record.daily)
    .filter((date) => daysBetween(date, today) < rangeDays)
    .sort()

  const dailyBuckets: ChartBucket[] = dates.map((date) => {
    const byModel: Record<string, number> = {}
    for (const [modelId, modelDay] of Object.entries(record.daily[date].models ?? {})) {
      byModel[modelId] = modelDay.inputTokens + modelDay.outputTokens
    }
    const total = Object.values(byModel).reduce((sum, n) => sum + n, 0)
    return { key: date, byModel, total }
  })

  if (granularity === 'daily') return dailyBuckets

  if (granularity === 'weekly') {
    const byWeek = new Map<string, ChartBucket>()
    for (const day of dailyBuckets) {
      const weekKey = startOfWeek(day.key)
      const bucket = byWeek.get(weekKey) ?? { key: weekKey, byModel: {}, total: 0 }
      for (const [modelId, tokens] of Object.entries(day.byModel)) {
        bucket.byModel[modelId] = (bucket.byModel[modelId] ?? 0) + tokens
      }
      bucket.total += day.total
      byWeek.set(weekKey, bucket)
    }
    return [...byWeek.values()].sort((a, b) => a.key.localeCompare(b.key))
  }

  // cumulative — running sum per model across the daily-sorted sequence.
  const running: Record<string, number> = {}
  let runningTotal = 0
  return dailyBuckets.map((day) => {
    for (const [modelId, tokens] of Object.entries(day.byModel)) {
      running[modelId] = (running[modelId] ?? 0) + tokens
    }
    runningTotal += day.total
    return { key: day.key, byModel: { ...running }, total: runningTotal }
  })
}

/** Derive the full renderer-facing `UsageProfile` from the raw persisted record. */
export function buildUsageProfile(record: TokenActivityRecord, today: string): UsageProfile {
  const dailyActivity: DailyUsageBucket[] = Object.keys(record.daily)
    .sort()
    .map((date) => ({ date, tokens: record.daily[date].tokens, generations: record.daily[date].generations }))

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

  const favoriteModel = buildModelBreakdown(record)[0] ?? null
  const peakHour = computePeakHour(record.hourly)

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
  if (lifetimeTokens > 0) {
    const multiplier = Math.round(lifetimeTokens / MOBY_DICK_APPROX_TOKENS)
    if (multiplier >= 1) {
      insights.push({ kind: 'referenceBook', multiplier, bookTitle: 'Moby-Dick' })
    }
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
    insights,
    sessionCount: record.sessionIds.length,
    peakHour,
    favoriteModel
  }
}
