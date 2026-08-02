import { APPROX_CHARS_PER_TOKEN } from '@shared/contextProjection'
import {
  computeModelToolResultBudget,
  type ModelToolResultBudget
} from '../tools/modelResultBudget'

/**
 * Per-round tool-result bounding for the cloud providers, which have no local
 * tokenizer to measure a prompt with.
 *
 * Every cloud provider used to pass `modelResultBudget: { current: null }`
 * permanently, on the reasoning that their context windows are large enough
 * that a single result could not threaten one. That holds for a single result
 * and not for a turn: with no budget, `clampModelResultCap` hands back whatever
 * cap the tool asked for, which is 60 KB for `read_file` and 180 KB for
 * `code_outline`. A tool-using turn may take up to `MAX_TOOL_ROUNDS` (20) of
 * those, every one of them re-sent on every later round, which overruns even a
 * 200K window — and the whole conversation is billed again each time it does.
 *
 * The budget shrinks as the turn fills, so it costs nothing early (a first
 * `read_file` against a fresh 200K window is nowhere near the cap) and bites
 * exactly when a long agent run is heading for the ceiling.
 */

/**
 * Reply room held back on a cloud round.
 *
 * `computeModelToolResultBudget` keeps its own `MIN_REPLY_RESERVE_TOKENS` for
 * the answer; this is the separate allowance for the response the provider is
 * about to stream, which on a cloud model is bounded by `max_tokens` rather
 * than by anything the local budget math can see.
 */
const CLOUD_OUTPUT_RESERVE_TOKENS = 8_192

/**
 * Bound one cloud round's tool results against what the model's window has left.
 *
 * @param contextWindowTokens The configured model's window, from `cloudContextWindowTokens`.
 * @param spentInputTokens Prompt tokens already committed this turn. Prefer the
 *   provider's own reported usage for the round just completed — it is exact,
 *   covers the system prompt and tool schemas, and costs nothing to obtain.
 *   Before the first response there is none, so callers estimate; see
 *   `estimateCloudInputTokens`.
 */
export function cloudToolResultBudget(
  contextWindowTokens: number,
  spentInputTokens: number
): ModelToolResultBudget {
  return computeModelToolResultBudget({
    contextSizeTokens: contextWindowTokens,
    inputLimitTokens: Math.max(0, contextWindowTokens - CLOUD_OUTPUT_RESERVE_TOKENS),
    fixedTokens: Math.max(0, spentInputTokens)
  })
}

/**
 * Coarse stand-in for the round-0 prompt, before any provider usage exists.
 *
 * Deliberately character-based and deliberately rough: it only has to be good
 * enough to keep the *first* tool result from claiming a window that upstream
 * history bounding has already fitted, and every round after this one uses the
 * provider's exact reported figure instead.
 */
export function estimateCloudInputTokens(...parts: Array<string | undefined>): number {
  const characters = parts.reduce((total, part) => total + (part?.length ?? 0), 0)
  return Math.ceil(characters / APPROX_CHARS_PER_TOKEN)
}
