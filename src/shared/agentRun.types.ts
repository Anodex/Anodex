import type { Plan } from './plan.types'
import type { AgentRunProviderId } from './agentRunProviders'
import { allocateContextBudget } from './contextBudget'

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

/**
 * The window the fixed turn constants above were sized against.
 *
 * `MAX_MAX_TURNS`'s own reasoning names it: "at the ~7.5k tokens a turn
 * actually costs, the 500k token ceiling is about 66 turns, so 60 puts the
 * three roughly in step". That 7.5k was measured on one model at one window,
 * and it is the whole problem - measured across 40 stored runs, a turn costs
 * between 94 and 10,802 tokens, a 115x spread.
 */
export const TURN_BUDGET_REFERENCE_CONTEXT = 65_536

/**
 * How much smaller a turn is here than at the reference window.
 *
 * A turn ends when the window fills, so the work one holds is its *working
 * set* - the window minus the output reserve, the reference context and the
 * tool schemas. Those have floors, so a small window loses proportionally more
 * of itself to them: at 8,192 the working set is not an eighth of 65,536's but
 * a ninth, and at 4,096 a twenty-fifth. Scaling on raw context size would miss
 * that; `allocateContextBudget` already models it exactly.
 *
 * This is a ratio between two windows, not a constant fitted to a machine. The
 * anchor is the pair the existing constants already assume.
 */
function turnWorkRatio(contextSize: number | undefined): number {
  if (!contextSize || contextSize <= 0) return 1
  const reference = allocateContextBudget(TURN_BUDGET_REFERENCE_CONTEXT).workingSet
  const here = allocateContextBudget(contextSize).workingSet
  if (here <= 0) return 1
  return reference / here
}

/**
 * The most turns a run may be configured with on this window.
 *
 * Measured: every run that hit its turn cap had spent almost none of the budget
 * it was actually given - 1.9%, 2.2% and 3.4% of tokens on a small window. The
 * run was ended by a count while the limits the user set were nowhere near
 * reached, and 60 was the largest number the app would accept, so there was no
 * way to configure around it.
 *
 * Never returns less than {@link MAX_MAX_TURNS}. Raising a ceiling removes a
 * limit; lowering one adds a limit nobody asked for, and a large window would
 * otherwise come out at 15. Tokens and elapsed time still bound a runaway, and
 * they are what a run actually costs.
 */
export function maxTurnsCeilingFor(contextSize: number | undefined): number {
  return Math.max(MAX_MAX_TURNS, Math.round(MAX_MAX_TURNS * turnWorkRatio(contextSize)))
}

/** The turn budget a new run starts with on this window. See {@link maxTurnsCeilingFor}. */
export function defaultMaxTurnsFor(contextSize: number | undefined): number {
  return Math.max(DEFAULT_MAX_TURNS, Math.round(DEFAULT_MAX_TURNS * turnWorkRatio(contextSize)))
}

/**
 * What produced a run, for comparing results afterwards. See
 * `describeRunProvenance` — descriptive only, never read to route anything.
 */
export interface RunProvenance {
  /** Local model file name without path or extension; null when unknown. */
  model: string | null
  /** The context window the run actually had. */
  contextSize: number | null
}

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
  provider: AgentRunProviderId
  /** Model id for any cloud provider; null for `'local'` (always whatever's loaded). */
  model: string | null
  /**
   * What actually ran, for local runs — see {@link RunProvenance}. Optional
   * because runs recorded before this existed have no answer, and guessing one
   * retrospectively would be worse than admitting it.
   */
  ranWith?: RunProvenance | null
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
  /**
   * Context epochs this run has started — each one dropped the history it had
   * accumulated and replaced it with a handoff.
   *
   * Recorded because it is the difference between a run that is working and
   * one that is grinding, and nothing else distinguishes them from outside.
   * Measured 2026-09-05 on the same model and benchmarks: at 65,536 a run
   * needs none, while at 8,192 several ran 150+ turns and 115,000 tokens
   * without closing a plan step.
   */
  contextEpochs?: number
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

/**
 * What a caller supplies to start a run; `AgentRunStore.create` fills the rest.
 *
 * Every budget is optional, and an omitted one is not "unlimited" - it takes
 * the default for the window this model has (see {@link defaultMaxTurnsFor}),
 * then is clamped to that window's ceiling. Passing a budget explicitly is
 * honoured up to the same ceiling.
 */
export interface CreateAgentRunRequest {
  goal: string
  projectId: string | null
  enabledTools: string[]
  provider: AgentRunProviderId
  model?: string | null
  /** Omitted takes {@link defaultMaxTurnsFor}; capped by {@link maxTurnsCeilingFor}. */
  maxTurns?: number
  /** Omitted takes `DEFAULT_MAX_TOKENS`; capped by `MAX_MAX_TOKENS`. */
  maxTokens?: number
  /** Omitted takes `DEFAULT_MAX_DURATION_MINUTES`; capped by `MAX_MAX_DURATION_MINUTES`. */
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
