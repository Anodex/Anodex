import type { Plan } from './plan.types'

/** How an agent run currently stands. */
export type AgentRunStatus = 'running' | 'needs-review' | 'done' | 'stopped' | 'error'

/** Default number of turns a run gets before it's stopped as budget-exhausted. */
export const DEFAULT_MAX_TURNS = 8

/** Hard ceiling a user can configure `maxTurns` up to. */
export const MAX_MAX_TURNS = 20

/** Default cumulative token budget for a run, across every turn. */
export const DEFAULT_MAX_TOKENS = 50_000

/** Hard ceiling a user can configure `maxTokens` up to. */
export const MAX_MAX_TOKENS = 500_000

/** Default wall-clock budget for a run, in minutes, from `createdAt`. */
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
  /** Wall-clock budget in minutes, measured from `createdAt`. */
  maxDurationMinutes: number
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
