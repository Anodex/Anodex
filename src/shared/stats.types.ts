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
}
