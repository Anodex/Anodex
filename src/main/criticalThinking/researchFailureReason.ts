import type { CriticalThinkingActivity } from '@shared/criticalThinking.types'

/**
 * What a run says when research produced no usable source and the reason is not
 * knowable from the activities.
 */
export const GENERIC_RESEARCH_FAILURE =
  'Research finished without a fetched source that could support a validated report.'

/**
 * Explain an empty research phase using what the run already recorded.
 *
 * A run on 2026-09-04 ended `partial` with 0/7 steps and zero sources, saying
 * only that research finished without a fetched source. That is the symptom at
 * the end of the chain. The cause was already in the same record: all 21 search
 * activities were `error`, every one of them reading "SearXNG is not reachable
 * at http://localhost:8080. The instance does not appear to be running — start
 * it, or choose a different search provider in Settings."
 *
 * The search backend was switched off, the run knew, and it reported something
 * that sounded like the question's fault. Those two outcomes look identical to
 * whoever reads the run, and only one of them is worth acting on.
 *
 * Deliberately narrow: the cause is named only when **every** search failed and
 * they all failed for the **same** stated reason. A run where some searches
 * worked came up empty for a reason this cannot see, and picking one message out
 * of several disagreeing ones would be inventing a diagnosis rather than
 * reporting one. In every other case the generic wording stands, because a vague
 * true statement beats a specific guess.
 */
export function researchFailureReason(activities: readonly CriticalThinkingActivity[]): string {
  const searches = activities.filter((activity) => activity.kind === 'search')
  if (searches.length === 0) return GENERIC_RESEARCH_FAILURE
  if (!searches.every((activity) => activity.status === 'error')) return GENERIC_RESEARCH_FAILURE

  const stated = searches
    .map((activity) => activity.detail?.trim())
    .filter((detail): detail is string => Boolean(detail))
  // A search that failed without saying why cannot vouch for the others'
  // explanation, so one silent failure is enough to fall back.
  if (stated.length !== searches.length) return GENERIC_RESEARCH_FAILURE

  const reasons = new Set(stated)
  if (reasons.size !== 1) return GENERIC_RESEARCH_FAILURE
  return namedReason([...reasons][0])
}

/** The generic sentence, with the cause the activities actually recorded. */
function namedReason(detail: string): string {
  return `Every search failed, so no sources could be gathered. ${detail}`
}
