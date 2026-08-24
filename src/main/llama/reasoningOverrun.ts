/**
 * Bound hidden reasoning on the llama-server transport, and recover the turn
 * when a round still ends with nothing but thinking.
 *
 * ## The failure
 *
 * `LlamaService`'s node-llama-cpp path gives every tool-carrying round a
 * `thoughtTokens` sub-budget, so reasoning cannot eat the whole reply
 * allowance before a call is attempted (see `defaultThoughtTokenBudget`).
 * `LlamaVisionService` — which is the whole engine for any model carrying a
 * multimodal projector, not just image turns — had no equivalent, and reasoning
 * there was bounded by nothing at all.
 *
 * Measured in one conversation: single reasoning segments of 63,882 and 75,715
 * characters against a 15,875-token reply cap, in a turn that ran 19.7 minutes
 * and changed no files.
 *
 * ## Why it repeated
 *
 * A round that produces no tool call and no visible text used to end the turn,
 * on the reading that the model "asked for nothing more". For a round cut off
 * at the token limit that reading is wrong: it did not finish, it ran out of
 * room. `boundedChatRunner` then opened a fresh cycle, the model started the
 * same task from the same state, and re-emitted the same opening sentence, the
 * same `list_directory` and the same `read_file`. One assistant message
 * contained that sequence twice, verbatim — the "it keeps repeating itself"
 * the user actually sees.
 *
 * ## Why the budget is the server's job
 *
 * The first attempt at this cut the reasoning stream client-side, at a budget
 * of the same size, and gave the round a corrective prompt afterwards. The live
 * probe (`liveReasoningRecovery.test.ts`) showed it does not work: four rounds
 * and 22 minutes on Qwen3.8-27B, no tool call, because **aborting a round
 * throws its reasoning away**. llama.cpp does not replay reasoning into history
 * by default, so each corrective round began with no record of the thinking it
 * was being told to act on, re-derived it from scratch, and hit the budget
 * again. It reproduced the restart loop inside one turn.
 *
 * `llama-server --reasoning-budget N` does the thing that actually helps: it
 * closes the thought segment at the budget and lets the **same round continue**
 * into its visible answer or tool call, reasoning intact. Measured on
 * Qwen3.8-27B with `--reasoning-budget 400`: reasoning fell from 3,198
 * characters to 1,628, and the round went from producing *zero* characters of
 * output to 3,932. It is a launch flag — the same value is rejected as a
 * per-request field, verified directly — so it is sized once, at load.
 *
 * {@link reasoningOverrunGuidance} remains as the backstop for a round that
 * still ends on nothing but thinking: an older engine build, a model whose
 * template ignores the budget, or a round whose visible answer runs out of room
 * too. It carries the tail of that reasoning back to the model precisely
 * because losing it is what broke the first attempt.
 */

import { defaultThoughtTokenBudget, minimumViableOutputTokens } from './localOutputBudget'

/**
 * Tokens of hidden reasoning one round may spend, for
 * `llama-server --reasoning-budget`.
 *
 * Sized through `defaultThoughtTokenBudget`, the same function the
 * node-llama-cpp path applies through `budgets.thoughtTokens`, so a model gets
 * the same share of its round to think in on either transport and only the
 * enforcement mechanism differs.
 *
 * ## Why it is sized against the *smallest* round, not a typical one
 *
 * A round's real allowance is `inputLimitTokens - fixedTokens`, which shrinks
 * as the turn accumulates tool traffic. `--reasoning-budget` is fixed at load
 * and cannot track that, so the only budget that is useful on **every** round
 * is one that binds on the tightest round the transport will still issue —
 * `minimumViableOutputTokens`.
 *
 * The first version of this sized against a quarter of the window instead
 * (3,276 tokens at 32K), on the theory that thinking should be generous where
 * there is room and the corrective prompt could catch the tight rounds. The
 * live probe measured that theory failing: with the budget above the round's
 * cap it never engaged, and three consecutive rounds spent their entire
 * allowance thinking and produced nothing, for 30 minutes. A budget that does
 * not bind is not a budget.
 *
 * The cost is that an early round with plenty of room still thinks only this
 * much. That is a real reduction and it is accepted deliberately, because the
 * measurements say it does not hurt: at a budget of 400 the same model went
 * from producing *zero* characters of output to 3,932. Being made to stop
 * deliberating and act is the point, not a side effect — and across a turn's
 * many rounds the model still accumulates far more thinking than the 75,715
 * characters that one runaway round used to spend.
 *
 * Returns `null` when there is no context size to size against — an unmeasured
 * window must not become a guess. `null` means "pass no flag", which leaves
 * llama-server's own default in place.
 */
export function reasoningBudgetTokens(contextSize: number | undefined): number | null {
  if (contextSize === undefined || !Number.isFinite(contextSize) || contextSize <= 0) return null
  // `hasTools: true` — this transport registers tools on any real chat turn,
  // and it is the larger of the two floors, so it is the one a budget has to
  // fit inside.
  const budget = defaultThoughtTokenBudget(minimumViableOutputTokens(contextSize, true))
  // A floor, because a budget of a few dozen tokens would cut a model off
  // mid-first-sentence — worse than the runaway this bounds.
  return Math.max(512, budget)
}

/**
 * How many corrective rounds a turn may spend on reasoning overruns.
 *
 * Two, matching `MAX_TOOL_CALL_RECOVERIES`: enough for a model that needs one
 * nudge to stop deliberating and act, and few enough that a model which only
 * ever thinks cannot spend the whole turn being told to stop.
 */
export const MAX_REASONING_OVERRUNS = 2

/** Characters of the cut-off reasoning handed back to the model. */
const CARRIED_REASONING_CHARS = 2_000

/**
 * What the model is told after a round ended on reasoning alone.
 *
 * It carries the **tail** of that reasoning — where the model left off — back
 * into the request. Without it the corrective round cannot see its own work:
 * llama.cpp does not replay reasoning into history, so "act on what you already
 * worked out" would name something the model can no longer read, and it will
 * dutifully work it out again. That is not a hypothesis; it is what the live
 * probe measured before this argument existed.
 *
 * Actionable rather than scolding, and specifically aimed at the behaviour that
 * follows a cut-off round: re-deriving the plan from the beginning.
 */
export function reasoningOverrunGuidance(reasoning: string): string {
  const tail = reasoning.trim().slice(-CARRIED_REASONING_CHARS)
  const instruction =
    'Your reasoning ran past the room this turn has for it and stopped before you acted. ' +
    'Do not plan any further and do not start over — act now. ' +
    'Make the single next tool call, keeping it small enough to finish. ' +
    'If you genuinely cannot act yet, say in one sentence what is blocking you.'
  return tail ? `Here is where your reasoning left off:\n\n${tail}\n\n${instruction}` : instruction
}
