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
 * `'once'` fires at `runAt` when that's set (a relative reminder like "in 10
 * minutes"), otherwise at the next occurrence of `hour`/`minute` (today if
 * still ahead, otherwise tomorrow); either way the task disables itself after.
 * `'interval'` ignores `hour`/`minute`/`weekdays` entirely and instead fires
 * every `every` `intervalUnit`s on a wall-clock grid anchored at `anchorAt`.
 */
export interface TaskRecurrence {
  type: RecurrenceType
  /** 0-23, local time. Unused for `'interval'`, and for `'once'` when `runAt` is set. */
  hour: number
  /** 0-59, local time. Unused for `'interval'`, and for `'once'` when `runAt` is set. */
  minute: number
  /** 0=Sunday..6=Saturday. Required for `'weekly'`, ignored otherwise. */
  weekdays?: number[]
  /** Only for `'interval'`: how many `intervalUnit`s between runs. */
  every?: number
  /** Only for `'interval'`. */
  intervalUnit?: IntervalUnit
  /**
   * Only for `'once'`: an absolute instant to fire at, used by relative
   * reminders ("in 10 minutes") which `hour`/`minute` can't express — that
   * pair can only say "next time the clock reads H:MM", never "N minutes from
   * now". Absent on a plain time-of-day one-shot.
   */
  runAt?: number
  /**
   * Only for `'interval'`: the wall-clock grid every run lands on, set once at
   * creation. Runs fire at `anchorAt + n * period` rather than chaining off
   * the previous run's *finish* time — otherwise a task whose runs take 10
   * minutes drifts to 40-minute spacing on a 30-minute schedule, and drifts
   * further every cycle. Absent on tasks persisted before this existed, which
   * fall back to the old from-now behaviour.
   */
  anchorAt?: number
}

export type ScheduledTaskRunStatus = 'success' | 'error' | 'stopped'

/** A single completed run, for the task's run-history report. */
export interface TaskRunRecord {
  id: string
  startedAt: number
  /** Wall-clock duration of the run. */
  durationMs: number
  status: ScheduledTaskRunStatus
  summary: string | null
  /** The assistant message in the task's conversation holding the full reply
   *  for this run, or null if the run failed before producing one. */
  messageId: string | null
  /** The user message that opened this run, used to segment the transcript by
   *  run. */
  userMessageId: string | null
  /**
   * How late this run started against the slot it was scheduled for. Only one
   * task runs at a time, so a task coming due while another is mid-run waits
   * for the lock rather than being dropped — routine on short intervals paired
   * with a slow local model, and previously invisible. 0 when it started on time.
   */
  delayedMs: number
  /**
   * Whole `'interval'` slots passed over between this run and the next one
   * scheduled after it — a long run, or a closed app, means those slots are
   * skipped rather than replayed (see `nextSlotOnGrid`). These are runs that
   * genuinely never happened, so the log says so instead of quietly omitting
   * them. Always 0 for non-interval recurrences.
   */
  skippedSlots: number
  /**
   * True when the run's reply claimed an outcome that didn't actually happen
   * — see `GenerateOutcome.fabricationDetected`'s doc comment in
   * `LlamaService.ts`. No one watches an unattended run live, so this is how
   * the report flags "this result may not be trustworthy, check the
   * transcript" after the fact. Always false for a run that errored before
   * producing a reply.
   */
  fabricationDetected: boolean
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
  /**
   * Total runs ever, including ones aged out of `runs`. Kept so the transcript
   * can number runs truthfully — numbering from the retained window alone would
   * relabel run 47 as run 20 the moment the history cap kicked in.
   */
  runCount: number
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
