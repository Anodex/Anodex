/**
 * Bound hidden reasoning on the llama-server transport, and recover the turn
 * when it runs long anyway.
 *
 * ## The failure
 *
 * `LlamaService`'s node-llama-cpp path gives every tool-carrying round a
 * `thoughtTokens` sub-budget, so reasoning cannot eat the whole reply
 * allowance before a call is attempted (see `defaultThoughtTokenBudget`).
 * `LlamaVisionService` — which is the whole engine for any model carrying a
 * multimodal projector, not just image turns — talks OpenAI-compatible HTTP to
 * a real `llama-server`, and that API has no equivalent knob. Reasoning there
 * was bounded by nothing at all.
 *
 * Measured in one conversation: single reasoning segments of 63,882 and 75,715
 * characters — roughly 16k and 19k tokens against a 15,875-token reply cap —
 * in a turn that ran 19.7 minutes and changed no files. The model narrated a
 * complete design and was cut off mid-sentence before it ever called a tool.
 *
 * ## Why it repeated
 *
 * A round that produces no tool call and no visible text used to end the turn,
 * on the reading that the model "asked for nothing more". That reading is
 * wrong for a round cut off at the token limit: the model did not finish, it
 * ran out of room. `boundedChatRunner` then opened a fresh cycle, the model
 * started the same task from the same state, and re-emitted the same opening
 * sentence, the same `list_directory`, the same `read_file`. In the measured
 * conversation one assistant message contained that sequence twice, verbatim —
 * the "it keeps repeating itself" the user actually sees.
 *
 * ## The two halves
 *
 * {@link reasoningBudgetChars} stops the runaway while it is still running, so
 * the cost is bounded rather than merely reported. {@link REASONING_OVERRUN_GUIDANCE}
 * gives the round somewhere to go afterwards, so a cut-off round becomes one
 * corrective round instead of a dead turn the next cycle repeats. Neither half
 * works alone: cutting without recovering ends the turn faster, and recovering
 * without cutting still spends twenty minutes to get there.
 */

import { defaultThoughtTokenBudget } from './localOutputBudget'

/**
 * Characters assumed per token when watching a reasoning stream.
 *
 * The budget has to be enforced on the deltas as they arrive, and no token
 * count is available until the stream reports usage at the end — by which
 * point the tokens are already spent. Four characters per token is the same
 * rough conversion used elsewhere for local estimates. It is deliberately
 * generous rather than accurate: over-estimating the budget wastes some
 * reasoning room, while under-estimating it would cut short a model that was
 * still within the allowance the text path grants for the same work.
 */
const CHARS_PER_TOKEN = 4

/**
 * How many characters of reasoning one round may stream before it is cut off.
 *
 * Sized from the same policy the node-llama-cpp path applies through
 * `budgets.thoughtTokens`, so the two transports give a model the same
 * proportion of its reply allowance to think in and only the enforcement
 * mechanism differs.
 *
 * Returns `null` when there is no meaningful cap to apply — an unmeasured or
 * nonsensical output cap must not be turned into a tiny budget that strangles
 * every round.
 */
export function reasoningBudgetChars(effectiveMaxTokens: number): number | null {
  if (!Number.isFinite(effectiveMaxTokens) || effectiveMaxTokens <= 0) return null
  const budgetTokens = defaultThoughtTokenBudget(effectiveMaxTokens)
  if (budgetTokens <= 0) return null
  return budgetTokens * CHARS_PER_TOKEN
}

/**
 * How many corrective rounds a turn may spend on reasoning overruns.
 *
 * Two, matching `MAX_TOOL_CALL_RECOVERIES`: enough for a model that needs one
 * nudge to stop deliberating and act, and few enough that a model which only
 * ever thinks cannot spend the whole turn being told to stop.
 */
export const MAX_REASONING_OVERRUNS = 2

/**
 * What the model is told after its reasoning was cut off.
 *
 * Written to be actionable rather than scolding, and specifically to stop the
 * behaviour that follows a cut-off round: re-deriving the plan from the
 * beginning. The model has already done the thinking — what it needs is
 * permission to act on the part it has.
 */
export const REASONING_OVERRUN_GUIDANCE =
  'Your reasoning ran past the room this turn has for it and was cut off before you acted. ' +
  'Do not plan any further and do not start over — act now on what you have already worked out. ' +
  'Make the single next tool call, keeping it small enough to finish. ' +
  'If you genuinely cannot act yet, say in one sentence what is blocking you.'
