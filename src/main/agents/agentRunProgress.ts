import type { Plan } from '@shared/plan.types'

/**
 * Whether an agent run is still getting anywhere, judged from the settled
 * record rather than from what its replies say.
 *
 * Separate from `agentTurnClaims` deliberately: that module asks whether a
 * reply was *true*, this one asks whether the run is *moving*. They were one
 * file briefly and the name stopped describing half of it.
 */

/**
 * Whether a run that called `finish_goal` has anything to show for itself.
 *
 * `finish_goal` is deliberately hard to refuse. The guard tells a model about
 * its open plan steps once and then lets the call through, because refusing it
 * repeatedly is how runs used to burn their whole budget arguing with a gate.
 * That is the right trade - but it means a run can declare success having done
 * nothing, and be recorded as `done` like any other.
 *
 * Measured: a run finished with six plan steps open, zero write, edit or patch
 * calls in sixteen turns, and a summary stating the function "has been
 * successfully implemented and verified" and that the smoke test "passed with
 * exit code 0". None of it had happened. The turn account underneath said
 * "Changed nothing", so the disclosure worked; the status said `done`.
 *
 * This changes nothing about whether the run may finish. It only decides
 * whether the result is presented as unqualified success, which is a claim
 * Anodex is making, not the model.
 *
 * Both conditions are needed. A run with no plan, or one whose every step is
 * complete, may legitimately have written nothing - "explain this module",
 * "is this safe to delete" - and flagging those would put a warning on exactly
 * the runs that behaved correctly.
 */
export function finishedWithNothingToShow(input: {
  durableChanges: number
  plan: Plan | null
}): boolean {
  if (input.durableChanges > 0) return false
  const steps = input.plan?.steps ?? []
  return steps.some((step) => step.status !== 'completed')
}

/**
 * Consecutive do-nothing turns before a run is stopped.
 *
 * Above two on purpose. A turn that reasons and then acts on the next one is
 * ordinary, and a limit of one or two would end runs that were about to work.
 * Three in a row is a model that has stopped driving the loop.
 */
export const IDLE_TURN_LIMIT = 3

/**
 * Why a run is being stopped for doing nothing, or `null` to keep going.
 *
 * An agent turn can only deliver anything through a tool call - `finish_goal`
 * included - so a turn with no calls at all has produced prose nobody will
 * read. Nothing watched for a run of them, and runs sat spinning until their
 * turn cap.
 *
 * Measured twice, on models three sizes apart. A Qwen3-4B run spent turns 22
 * through 30 - nine consecutive turns - making no tool calls and then hit its
 * limit with an empty workspace and a plan at 0/4. DeepSeek-R1-Distill-32B did
 * the same for six turns, emitting byte-identical replies each time.
 *
 * Counted in tool calls rather than by comparing replies. Two models produced
 * this and only one of them repeated itself, so the repetition was incidental;
 * "did this turn do anything" is the question, and it needs no text comparison
 * and behaves the same in every language.
 *
 * The reason states what was observed and nothing more. Why a model stopped
 * calling tools is not knowable from here - a small context, an unparseable
 * reply and a model that has simply given up all look identical at this level -
 * and a run that guessed at the cause would be guessing in the user's name.
 */
export function idleRunReason(consecutiveIdleTurns: number): string | null {
  if (consecutiveIdleTurns < IDLE_TURN_LIMIT) return null
  return (
    `Stopped after ${consecutiveIdleTurns} turns in a row without making a single tool call. ` +
    'The model was still replying, but an agent run can only act - or finish - through a tool, ' +
    'so those turns changed nothing and the next ones were unlikely to. Nothing here says why it ' +
    'stopped calling tools; the transcript will show what it was saying instead.'
  )
}
