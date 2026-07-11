/** How an agent run currently stands. */
export type AgentRunStatus = 'running' | 'done' | 'stopped' | 'error'

/** Default number of turns a run gets before it's stopped as budget-exhausted. */
export const DEFAULT_MAX_TURNS = 8

/** Hard ceiling a user can configure `maxTurns` up to. */
export const MAX_MAX_TURNS = 20

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
  /** The conversation this run's turns append to, created on start. */
  conversationId: string | null
  /** Set once the model calls `finish_goal`, or on an error. */
  summary: string | null
  lastError: string | null
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
}
