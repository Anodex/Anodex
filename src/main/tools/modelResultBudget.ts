/**
 * Bounds on how much text from ONE tool result may be injected into the
 * active model exchange, derived from the provider's real measured context
 * budget for this turn — not the disk-safety byte limits a tool enforces
 * when reading a file. A tool may retain a complete artifact on disk or in a
 * durable sidecar; only the text handed back to the model is bounded here.
 */
export interface ModelToolResultBudget {
  /** Total context window for the active provider/model, in tokens. */
  contextSizeTokens: number
  /** Local: max renderable input before context-shift room is lost. Equals contextSizeTokens elsewhere. */
  inputLimitTokens: number
  /** System prompt, wrapper framing, current prompt, and active tool schemas, measured before this result. */
  fixedTokens: number
  /** Tokens always reserved for a useful reply after this tool result lands. */
  minimumReplyReserveTokens: number
  /** Hard per-result cap in tokens — never inject more than this from a single tool call. */
  maxTokensPerResult: number
}

export interface ModelToolResultBudgetInput {
  contextSizeTokens: number
  inputLimitTokens: number
  fixedTokens: number
}

const MIN_REPLY_RESERVE_TOKENS = 1_024
const MIN_RESULT_TOKENS = 256
/**
 * Fraction of the remaining exchange room (after the reply reserve) one
 * result may claim. Originally 0.22 — the recovery plan's own starting
 * experiment ("cap one result to no more than 20-25% of the remaining
 * exchange room"), explicitly flagged as unproven pending a real-hardware
 * measurement. That measurement came back live at the exact 8K fixture: at
 * 0.22, `read_file_range` returned only ~20-40 lines per call (the fixed
 * per-turn overhead dominates a 200-line request), so reading two files of
 * 2,352 and 1,109 lines to completion alone consumed 84 tool calls and the
 * full 15-minute bounded-task budget, leaving no room for the other 10+
 * files a 12-file audit needed. Raising the fraction doesn't change how much
 * file content ultimately moves through the context — it changes how many
 * round trips (each with its own repeated header/narration overhead) that
 * costs. 0.5 roughly doubles lines served per call in the same measured
 * deficit while still leaving `MIN_REPLY_RESERVE_TOKENS` fully protected
 * beneath it and comfortably clearing `MIN_RESULT_TOKENS`'s floor even in
 * the tightest observed cycle (see `modelResultBudget.test.ts`'s live-8K
 * fixtures). Revisit again once measured at other context sizes.
 */
const MAX_RESULT_FRACTION_OF_REMAINING = 0.5
/**
 * Conservative characters-per-token ratio used only where no real tokenizer
 * is available at the call site (the tool-helper boundary, ahead of
 * whatever exact tokenizer-based enforcement a provider owns). Deliberately
 * on the low side — source code and JSON run denser in tokens than prose —
 * so this under-estimates capacity rather than over-promising it.
 */
const CONSERVATIVE_CHARS_PER_TOKEN = 3

/** Derive the per-result token cap from one turn's real, measured context accounting. */
export function computeModelToolResultBudget(
  input: ModelToolResultBudgetInput
): ModelToolResultBudget {
  const remainingInputTokens = Math.max(0, input.inputLimitTokens - input.fixedTokens)
  const afterReserve = Math.max(0, remainingInputTokens - MIN_REPLY_RESERVE_TOKENS)
  const maxTokensPerResult =
    afterReserve <= 0
      ? 0
      : Math.min(
          afterReserve,
          Math.max(MIN_RESULT_TOKENS, Math.floor(afterReserve * MAX_RESULT_FRACTION_OF_REMAINING))
        )
  return {
    contextSizeTokens: input.contextSizeTokens,
    inputLimitTokens: input.inputLimitTokens,
    fixedTokens: input.fixedTokens,
    minimumReplyReserveTokens: MIN_REPLY_RESERVE_TOKENS,
    maxTokensPerResult
  }
}

/** Token allowance for one result, expressed as a conservative character count. */
export function modelResultCharBudget(budget: ModelToolResultBudget): number {
  return budget.maxTokensPerResult * CONSERVATIVE_CHARS_PER_TOKEN
}

/**
 * The effective character cap for one tool result: the tool's own requested
 * cap, clamped down (never up) to what the active runtime budget allows. A
 * tool may request a smaller cap than the runtime allows; it can never use
 * this to exceed it. Returns the requested cap unchanged when no budget is
 * known yet (e.g. a cloud provider this pass doesn't measure) — the
 * pre-existing behavior for that case.
 */
export function clampModelResultCap(
  requestedCap: number,
  budget: ModelToolResultBudget | null
): number {
  if (!budget) return requestedCap
  return Math.min(requestedCap, modelResultCharBudget(budget))
}
