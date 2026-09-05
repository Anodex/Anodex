import type { GenerationStopReason } from '@shared/chat.types'
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
 * calling tools is usually not knowable from here - an unparseable reply and a
 * model that has simply given up look identical at this level - and a run that
 * guessed at the cause would be guessing in the user's name.
 *
 * One case is knowable, and was being reported as if it were not. Measured on
 * bench-1, qwen27b at 8,192 (2026-09-05): seven turns were ended by the runtime
 * with "no room left for a usable reply" - 6,574 tokens of fixed input against
 * a 7,680 limit with 1,280 reserved for the reply - and the run reported that
 * the model "was still replying" and that "nothing here says why it stopped
 * calling tools". The model was not still replying; its turns were aborted
 * before it could act, and every one of them carried a stop reason saying so.
 * Reporting a context limit as a model that gave up sends the reader to change
 * models when they need a larger window or fewer bound tools.
 *
 * So the caller passes what ended each idle turn, and the cause is named only
 * when every one of them agrees - the same rule `researchFailureReason` uses,
 * and for the same reason.
 */
export function idleRunReason(
  consecutiveIdleTurns: number,
  idleStopReasons: readonly (GenerationStopReason | undefined)[] = []
): string | null {
  if (consecutiveIdleTurns < IDLE_TURN_LIMIT) return null
  // The paragraph above holds wherever the record is silent or disagrees with
  // itself. Where every one of those turns was ended by the runtime for the
  // same knowable reason, it is not a guess: it is what happened.
  if (
    idleStopReasons.length >= consecutiveIdleTurns &&
    idleStopReasons.every(
      (reason) => reason === 'context-limit' || reason === 'fixed-context-limit'
    )
  ) {
    return (
      `Stopped after ${consecutiveIdleTurns} turns in a row that made no tool call, because ` +
      'each of them ran out of context before it could act. The model was not given the chance ' +
      'to reply: the prompt left less room than a usable answer needs. A larger context window, ' +
      'or fewer tools bound to the turn, is what this needs - changing models will not help.'
    )
  }
  return (
    `Stopped after ${consecutiveIdleTurns} turns in a row without making a single tool call. ` +
    'The model was still replying, but an agent run can only act - or finish - through a tool, ' +
    'so those turns changed nothing and the next ones were unlikely to. Nothing here says why it ' +
    'stopped calling tools; the transcript will show what it was saying instead.'
  )
}

/**
 * Consecutive turns in which every call was refused before a run is stopped.
 *
 * Above two, like {@link IDLE_TURN_LIMIT}: hitting a guard once or twice and
 * then varying the call is ordinary work. Five in a row is a model that is not
 * varying anything.
 */
export const REFUSED_TURN_LIMIT = 5

/**
 * Why a run is being stopped for getting nothing but refusals, or `null` to
 * keep going.
 *
 * The sibling of {@link idleRunReason}, and needed because that one cannot see
 * this: these turns *do* make tool calls, they are simply all refused, so a
 * turn-call count reads them as active.
 *
 * Measured on bench-1 with a 4B model at an 8,192-token window. The run made
 * its last successful call at turn 19, then spent **181 consecutive turns**
 * where every call was refused — the loop guard answering "you've already
 * called read_file_range with identical effective arguments" — and reached its
 * 200-turn cap having spent 5% of its tokens. Ninety per cent of the run was
 * spent being told no.
 *
 * A guard refusing a call is Anodex working correctly; a run continuing to make
 * only refused calls for turn after turn is not. The guards say no to a call,
 * and nothing was saying no to the pattern.
 *
 * States what was observed and nothing more. Why a model stopped varying its
 * calls is not knowable from here.
 */
export function refusedRunReason(consecutiveRefusedTurns: number): string | null {
  if (consecutiveRefusedTurns < REFUSED_TURN_LIMIT) return null
  return (
    `Stopped after ${consecutiveRefusedTurns} turns in a row in which every tool call was ` +
    'refused. The calls were being rejected as repeats or as gathering without progress, and ' +
    'nothing new was getting through, so those turns changed nothing and the next ones were ' +
    'unlikely to. The transcript shows what it kept trying.'
  )
}

/**
 * Why a run ended before it started, when the model produced no plan.
 *
 * Measured on a 13B roleplay merge at 4,096 tokens: the run ended after two
 * turns and 399 tokens with "Could not produce a plan for review." Anodex
 * behaved well - it asked, retried, and stopped cheaply rather than grinding
 * thirty turns against a model that could not do the job - but the message
 * named the symptom and left the reader to guess the cause.
 *
 * A plan comes from a tool call, so a model that cannot reliably call tools
 * cannot start a run at all. That is worth saying, because it is the commonest
 * reason a model fails here and the fix is to pick a different model rather
 * than to change any setting.
 *
 * Stated as what a plan needs, never as a diagnosis of the model. Anodex cannot
 * know why a particular model failed, and "your model does not support tool
 * use" would be a guess with a confident face - the same mistake the phrase
 * detectors made before they were removed.
 */
export function noPlanReason(attempts: number): string {
  const tried = attempts > 1 ? 'twice' : 'once'
  return (
    `Asked ${tried} for a plan and did not get one, so the run could not start. A plan is made ` +
    'by calling a tool, so this is where a model that cannot reliably call tools stops — check ' +
    'the transcript for what it replied instead. Nothing here needs a settings change.'
  )
}
