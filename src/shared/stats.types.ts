/** Token generation activity for a single local calendar day. */
export interface DailyUsageBucket {
  /** `YYYY-MM-DD`, in the user's local timezone. */
  date: string
  tokens: number
  generations: number
}

/** How many times a given tool was called, across all conversations ever. */
export interface ToolUsageCount {
  name: string
  count: number
}

/** Lifetime input/output token split for a single model. */
export interface ModelUsageBreakdown {
  modelId: string
  modelName: string
  inputTokens: number
  outputTokens: number
  /** (inputTokens + outputTokens) / lifetime combined total across all models, 0-1. */
  share: number
}

export type ChartRange = 'all' | '30d' | '7d'
export type ChartGranularity = 'daily' | 'weekly' | 'cumulative'

/** One point on the token-activity chart — combined (input+output) tokens per model. */
export interface ChartBucket {
  /** The bucket's day (`daily`/`cumulative`) or week-start date (`weekly`), `YYYY-MM-DD`. */
  key: string
  byModel: Record<string, number>
  total: number
}

export interface UsageBreakdown {
  /** Sorted by combined (input+output) tokens descending. */
  models: ModelUsageBreakdown[]
  /** Oldest-first. */
  chart: ChartBucket[]
}

/**
 * A notable, derived fact about the user's usage — kept as structured data
 * rather than a pre-formatted string, so wording/phrasing stays a renderer
 * concern instead of being baked into the main-process store.
 */
export type UsageInsight =
  | { kind: 'streak'; days: number }
  | { kind: 'busiestDay'; date: string; tokens: number }
  | { kind: 'favoriteTool'; name: string; count: number }
  | { kind: 'longestTask'; durationMs: number }
  | { kind: 'referenceBook'; multiplier: number; bookTitle: string }

/** Aggregated, all-time usage stats — independent of any individual conversation. */
export interface UsageProfile {
  lifetimeTokens: number
  lifetimeGenerations: number
  peakDay: { date: string; tokens: number } | null
  longestGenerationDurationMs: number
  currentStreakDays: number
  longestStreakDays: number
  /** Oldest-first, one entry per day that has ever had activity. */
  dailyActivity: DailyUsageBucket[]
  /** Sorted by count descending. */
  mostUsedTools: ToolUsageCount[]
  insights: UsageInsight[]
  /** Distinct conversations ever recorded against, surviving conversation deletion. */
  sessionCount: number
  /** Local hour (0-23) with the most generations, lifetime; `null` if no activity yet. */
  peakHour: number | null
  /** Model with the highest combined (input+output) lifetime tokens; `null` if no activity yet. */
  favoriteModel: ModelUsageBreakdown | null
}
