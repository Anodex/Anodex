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

/**
 * What a run that ran out of *turns* still had left, so the reader can tell a
 * mis-sized turn cap from a model that could not do the job.
 *
 * A turn is not a fixed unit of work: it holds as much as the context window
 * has room for after the system prompt, tool schemas and history. Measured on
 * one machine, same model, same task shape — at a 65,536-token window a turn
 * carried about 11 tool calls; at 8,192 it carried about 1.2, because roughly
 * 1,400 tokens of working room fits a single tool result.
 *
 * So `maxTurns: 25` means very different amounts of work on different hardware,
 * while the token and time budgets mean the same thing everywhere. A live 8K
 * run stopped at 25/25 turns having completed 0 of 4 plan steps, with **1.9%**
 * of its token budget and almost none of its time spent, 28 tool calls and zero
 * failures. It reported only the last turn's outcome, so it read as a model
 * that had achieved nothing rather than a budget denominated in the wrong unit.
 *
 * This states the leftovers rather than changing the cap. The cap is the user's
 * and a run that is genuinely looping should still hit it; what was missing was
 * any way to tell the two apart.
 */
export function turnBudgetLeftovers(
  run: Pick<AgentRun, 'maxTokens' | 'maxDurationMinutes'>,
  tokensUsed: number,
  elapsedMs: number
): string {
  const tokenPct = run.maxTokens > 0 ? (tokensUsed / run.maxTokens) * 100 : 0
  const minutesUsed = Math.round(elapsedMs / 60_000)
  const spent =
    `Used ${tokensUsed.toLocaleString()} of ${run.maxTokens.toLocaleString()} tokens ` +
    `(${tokenPct < 1 ? '<1' : Math.round(tokenPct)}%) and ${minutesUsed} of ` +
    `${run.maxDurationMinutes} minutes.`
  // Only worth saying when the other budgets really were untouched; a run that
  // spent everything hit a real ceiling and needs no explaining away.
  if (tokenPct >= 50) return spent
  return (
    `${spent} A turn holds as much work as the context window has room for, so a ` +
    'smaller window needs more turns for the same task — raising the turn limit ' +
    'will let this continue if it was making progress.'
  )
}
