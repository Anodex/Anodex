/** How often a scheduled task repeats. */
export type RecurrenceType = 'once' | 'daily' | 'weekly' | 'interval'

export type IntervalUnit = 'minutes' | 'hours' | 'days'

/**
 * Floor on an `'interval'` recurrence, shared by the recurrence math (which
 * enforces it) and the editor UI (which hints it) — below this, a task starts
 * hammering the local model and spamming toasts far faster than it's useful for.
 */
export const MIN_INTERVAL_MINUTES = 5

/**
 * When a scheduled task fires. `weekdays` is only meaningful for `'weekly'` —
 * a "Weekdays" preset in the UI is just `weekly` with `[1, 2, 3, 4, 5]`.
 * `'once'` has no date: it fires at the next occurrence of `hour`/`minute`
 * (today if still ahead, otherwise tomorrow), then the task disables itself.
 * `'interval'` ignores `hour`/`minute`/`weekdays` entirely and instead fires
 * every `every` `intervalUnit`s, counted from whenever it last finished (or
 * from creation, before its first run).
 */
export interface TaskRecurrence {
  type: RecurrenceType
  /** 0-23, local time. Unused for `'interval'`. */
  hour: number
  /** 0-59, local time. Unused for `'interval'`. */
  minute: number
  /** 0=Sunday..6=Saturday. Required for `'weekly'`, ignored otherwise. */
  weekdays?: number[]
  /** Only for `'interval'`: how many `intervalUnit`s between runs. */
  every?: number
  /** Only for `'interval'`. */
  intervalUnit?: IntervalUnit
}

export type ScheduledTaskRunStatus = 'success' | 'error' | 'stopped'

/** A single completed run, for the task's run-history report. */
export interface TaskRunRecord {
  id: string
  startedAt: number
  status: ScheduledTaskRunStatus
  summary: string | null
  /** The assistant message in the task's conversation holding the full reply
   *  for this run, or null if the run failed before producing one. */
  messageId: string | null
}

/** A user-defined automated prompt that runs on a recurring schedule. */
export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  /** The project this task's runs are scoped to, or null for a plain chat. */
  projectId: string | null
  recurrence: TaskRecurrence
  /** Tool names (see `TOOL_CATALOG`) this task may use unattended. Empty = chat-only. */
  enabledTools: string[]
  enabled: boolean
  /** The conversation this task's runs append to, created lazily on first run. */
  conversationId: string | null
  createdAt: number
  updatedAt: number
  /** When this task will next fire, or null once a `'once'` task has run or while disabled. */
  nextRunAt: number | null
  lastRunAt: number | null
  lastRunStatus: ScheduledTaskRunStatus | null
  lastRunSummary: string | null
  /** Most recent runs first, capped (see `MAX_RUN_HISTORY`). */
  runs: TaskRunRecord[]
}

export interface CreateScheduledTaskRequest {
  name?: string
  prompt: string
  projectId: string | null
  recurrence: TaskRecurrence
  enabledTools: string[]
}

export type UpdateScheduledTaskRequest = Partial<CreateScheduledTaskRequest> & {
  enabled?: boolean
}
