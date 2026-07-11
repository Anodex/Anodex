import type { AgentRun } from '@shared/agentRun.types'

/**
 * Checked once per completed turn, between turns — not mid-turn.
 * `runGeneration()` has no per-token preemption hook, so a single turn can
 * still overshoot the remaining budget before this fires; the guarantee is
 * that the *loop* stops there, not that usage is capped to the exact number.
 * Token budget is checked first when both are exceeded (order is arbitrary
 * but deterministic).
 */
export function budgetExceededReason(
  run: Pick<AgentRun, 'maxTokens' | 'maxDurationMinutes' | 'createdAt'>,
  tokensUsedSoFar: number,
  elapsedMs: number
): string | null {
  if (tokensUsedSoFar >= run.maxTokens) {
    return `Stopped: token budget of ${run.maxTokens.toLocaleString()} reached.`
  }
  if (elapsedMs >= run.maxDurationMinutes * 60_000) {
    return `Stopped: ${run.maxDurationMinutes}-minute time budget reached.`
  }
  return null
}
