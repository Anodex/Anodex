import type { AgentRun, CreateAgentRunRequest } from './agentRun.types'
import { seriesIdOf } from './agentRun.types'

/**
 * Starting the next run of ongoing work, without a person pressing Continue.
 *
 * The Agent workbench already knows how to carry work across runs: a series, a
 * journal of what each run did, and a Continue button that starts the next one
 * knowing all of it. What it could not do is advance on its own, which left
 * "keep this up to date" as a thing you have to remember to press — and an
 * assistant you have to remember to press is a button, not an assistant.
 *
 * ## Why the settings are read at fire time, not stored
 *
 * A schedule could have captured the run's provider, tools and budgets when it
 * was created. It deliberately does not: it stores the series id and nothing
 * else, and reads the shape off the most recent run each time it fires.
 *
 * That makes the last run the single source of truth. Continue a series by
 * hand with a bigger budget or a different provider and the schedule follows,
 * because there is only one place the answer lives. A stored copy would drift
 * from what the series is actually doing and nothing would ever say so.
 */

/** Why a scheduled continuation could not start. Reported, never thrown. */
export interface ContinuationRefusal {
  error: string
}

/**
 * The run to model the next one on: the newest top-level run of the series.
 *
 * Sub-agents are excluded. A delegated run is a step inside its parent, with a
 * tool set its parent chose for it and a goal that is one slice of the real
 * one — continuing from it would resume the slice and lose the work.
 */
export function latestRunOfSeries(
  runs: readonly AgentRun[],
  seriesId: string
): AgentRun | undefined {
  let latest: AgentRun | undefined
  for (const run of runs) {
    if (run.parentRunId) continue
    if (seriesIdOf(run) !== seriesId) continue
    if (!latest || run.createdAt > latest.createdAt) latest = run
  }
  return latest
}

/**
 * What to start, to continue a series once more.
 *
 * Everything about the shape of the run is inherited — provider, model, tools,
 * budgets, whether a plan is reviewed — because the point is to do the same
 * work again, not a different kind of work. Only the series is added.
 *
 * `requirePlan` is inherited rather than forced off. A run that waits for
 * approval is the user's choice and a reasonable one for unattended work; what
 * would not be reasonable is silently removing a review they asked for because
 * nobody is watching. The control that creates these says what it will do.
 */
export function continuationRequestFor(
  runs: readonly AgentRun[],
  seriesId: string
): CreateAgentRunRequest | ContinuationRefusal {
  const latest = latestRunOfSeries(runs, seriesId)
  if (!latest) {
    return {
      error: 'The work this schedule continues no longer exists — every run of it has been deleted.'
    }
  }
  return {
    goal: latest.goal,
    continuesSeriesId: seriesId,
    projectId: latest.projectId,
    enabledTools: [...latest.enabledTools],
    provider: latest.provider,
    model: latest.model,
    maxTurns: latest.maxTurns,
    maxTokens: latest.maxTokens,
    maxDurationMinutes: latest.maxDurationMinutes,
    limitsEnabled: latest.limitsEnabled,
    requirePlan: latest.requirePlan
  }
}

/**
 * Whether a series already has work in flight.
 *
 * A schedule that fires while its own previous run is still going would have
 * two runs appending to one journal and editing one workspace. The second is
 * skipped rather than queued: the work is recurring, so the next occurrence is
 * a better time to do it than the moment this one finishes, and a queue of
 * overdue continuations is how an unattended feature runs away.
 */
export function seriesIsBusy(runs: readonly AgentRun[], seriesId: string): boolean {
  return runs.some(
    (run) =>
      !run.parentRunId &&
      seriesIdOf(run) === seriesId &&
      (run.status === 'running' || run.status === 'needs-review')
  )
}
