import type { Plan } from './plan.types'

/** How an agent run currently stands. */
export type AgentRunStatus = 'running' | 'needs-review' | 'done' | 'stopped' | 'error'

/** Default number of turns a run gets before it's stopped as budget-exhausted. */
export const DEFAULT_MAX_TURNS = 8

/**
 * Hard ceiling a user can configure `maxTurns` up to.
 *
 * Sized against the other two budgets rather than picked on its own. A run is
 * bounded by turns, tokens and time together, and any one of them stops it --
 * but at 20 the turn budget was roughly three times tighter than the others, so
 * in practice it was the only one that ever fired. Measured on a real run: it
 * stopped at 20/20 turns having spent 151k of its 500k tokens and half its
 * time, and left the work unfinished with a broken build.
 *
 * At the ~7.5k tokens a turn actually costs, the 500k token ceiling is about 66
 * turns, so 60 puts the three roughly in step. Raising it removes a limit
 * rather than adding one: tokens and elapsed time still bound a runaway, and
 * the default stays at {@link DEFAULT_MAX_TURNS} so nothing changes for a run
 * that does not ask for more.
 */
export const MAX_MAX_TURNS = 60

/** Default cumulative token budget for a run, across every turn. */
export const DEFAULT_MAX_TOKENS = 50_000

/** Hard ceiling a user can configure `maxTokens` up to. */
export const MAX_MAX_TOKENS = 500_000

/** Default budget for a run, in minutes of time actually spent working. */
export const DEFAULT_MAX_DURATION_MINUTES = 30

/** Hard ceiling a user can configure `maxDurationMinutes` up to (4 hours). */
export const MAX_MAX_DURATION_MINUTES = 240

/**
 * A single unattended, goal-directed run: a loop of assistant turns against
 * its own conversation until the model calls `finish_goal` (`status: 'done'`),
 * `maxTurns` is exhausted (`status: 'stopped'`), or the run errors.
 */
export interface AgentRun {
  id: string
  goal: string
  status: AgentRunStatus
  /** The project this run's tools are scoped to, or null for a plain chat. */
  projectId: string | null
  /** Tool names (see `TOOL_CATALOG`) this run may use, beyond the always-on skill tools. */
  enabledTools: string[]
  /** Which backend this run uses, independent of the user's global active provider. */
  provider: 'local' | 'anthropic' | 'openai'
  /** Model id for `provider: 'anthropic' | 'openai'`; null for `'local'` (always whatever's loaded). */
  model: string | null
  maxTurns: number
  turnsUsed: number
  /**
   * How many of this run's turns had a reply that claimed an outcome — a file
   * change, an approval/denial — that didn't actually happen (see
   * `GenerateOutcome.fabricationDetected`'s doc comment in `LlamaService.ts`).
   * No one watches an unattended run live, so this is how the UI flags "this
   * result may not be trustworthy, check the transcript" after the fact,
   * instead of silently reporting success. Always 0 for a cloud-provider run
   * (Anthropic/OpenAI) — that detection is local-model-specific.
   */
  flaggedTurns: number
  /** Cumulative token budget across every turn. */
  maxTokens: number
  tokensUsed: number
  /** Wall-clock budget in minutes, measured against `activeMs` — time spent working. */
  maxDurationMinutes: number
  /**
   * Milliseconds this run has actually spent generating, summed across its
   * planning phase and every execution segment.
   *
   * Deliberately not `now - createdAt`, which is what the budget used to be
   * measured against. `requirePlan` defaults to true, so the default shape of a
   * run is: plan, then sit in `needs-review` until a human looks at it. Charging
   * that wait to the work budget meant a user who approved a plan after lunch
   * got a run that stopped on arrival, having executed nothing, blaming a time
   * budget their own deliberation had spent. Approval is the one part of a run
   * that is explicitly not the agent working.
   *
   * Absent on runs persisted before this field existed; read it through
   * `activeElapsedMs`.
   */
  activeMs: number
  /**
   * When the current execution or planning segment started, or null when the
   * run is not generating. Lets a live view add the in-flight segment to
   * `activeMs` without waiting for the next turn to persist it.
   */
  activeSinceAt: number | null
  /**
   * When false, `maxTurns`/`maxTokens`/`maxDurationMinutes` are never enforced — the
   * run continues until it finishes itself or is stopped manually. The budget values
   * themselves are unchanged either way; this only gates whether they're checked.
   */
  limitsEnabled: boolean
  /** The conversation this run's turns append to, created on start. */
  conversationId: string | null
  /** Set once the model calls `finish_goal`, or on an error. */
  summary: string | null
  lastError: string | null
  /**
   * When true, the run does a planning-only turn first and pauses in
   * `needs-review` until a human approves the proposed plan, before any
   * real (write/command/web) tool becomes available. Defaults to true —
   * unattended runs otherwise have no checkpoint at all before acting.
   */
  requirePlan: boolean
  /**
   * The run's plan: the proposal while `status: 'needs-review'`, then the
   * live execution checklist (kept current via `update_plan_step`) once
   * approved. Null for a run created with `requirePlan: false`, or before
   * the planning turn produces one.
   */
  plan: Plan | null
  createdAt: number
  updatedAt: number
}

export interface CreateAgentRunRequest {
  goal: string
  projectId: string | null
  enabledTools: string[]
  provider: 'local' | 'anthropic' | 'openai'
  model?: string | null
  maxTurns?: number
  maxTokens?: number
  maxDurationMinutes?: number
  /** Defaults to true — pass false to let the run continue unbounded until it finishes itself. */
  limitsEnabled?: boolean
  /** Defaults to true — see `AgentRun.requirePlan`. */
  requirePlan?: boolean
}

/**
 * How long this run has actually been working: everything already banked in
 * `activeMs`, plus the segment currently in flight.
 *
 * The single reader for both the budget checks in main and the Time gauge in
 * the renderer, so the number the user watches climb is the same one that
 * stops the run. `?? 0` covers runs persisted before these fields existed —
 * their history is lost either way, and starting them from zero is the
 * forgiving direction.
 */
export function activeElapsedMs(
  run: Pick<AgentRun, 'activeMs' | 'activeSinceAt'>,
  now = Date.now()
): number {
  const banked = run.activeMs ?? 0
  return run.activeSinceAt ? banked + Math.max(0, now - run.activeSinceAt) : banked
}
