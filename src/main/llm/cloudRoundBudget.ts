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
 * Most of the input limit an *estimated* round-0 spend is allowed to claim.
 *
 * The seed below is a guess, and a guess that reads high must not be able to
 * zero the budget: `computeModelToolResultBudget` returns `maxTokensPerResult:
 * 0` once nothing is left, `clampModelResultCap` turns that into a 0-character
 * cap, and every tool on the first round then hands the model an empty result.
 * Capping the guess means a bad estimate can narrow the first result but never
 * delete it — and round 1 replaces the guess with the provider's exact figure
 * regardless.
 */
const MAX_ESTIMATED_SPEND_FRACTION = 0.9

/**
 * Bound one cloud round's tool results against what the model's window has left.
 *
 * @param contextWindowTokens The configured model's window, from `cloudContextWindowTokens`.
 * @param spentInputTokens Prompt tokens already committed this turn. Prefer the
 *   provider's own reported usage for the round just completed — it is exact,
 *   covers the system prompt and tool schemas, and costs nothing to obtain.
 *   Before the first response there is none; use `seedCloudToolResultBudget`.
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
 * The round-0 spend estimate, before the provider has reported any usage.
 *
 * Deliberately coarse — it only has to keep the *first* tool result from
 * claiming a window that upstream history bounding has already fitted, and
 * `advanceCloudSpentTokens` replaces it with the provider's exact figure from
 * round 1 onward.
 *
 * Two things it must get right, both learned the hard way:
 *
 * - Binary payloads are excluded. Rendered messages carry attached images as
 *   base64, and counting those characters as prompt text is wildly wrong: one
 *   800 KB screenshot estimates at ~273,000 tokens, which against a 200,000
 *   window zeroes the budget and hands the model an empty result from every
 *   tool it calls on the first round.
 * - The estimate cannot claim the whole window (see
 *   `MAX_ESTIMATED_SPEND_FRACTION`), so no future mis-estimate can reproduce
 *   that failure mode either.
 */
export function estimateCloudSpentTokens(
  contextWindowTokens: number,
  parts: {
    /** Sent out of band on most providers, so it is not inside `rendered`. */
    systemPrompt?: string
    /** The rendered message/input array for round 0, prompt included. */
    rendered: unknown
    /** The rendered tool schemas, when this turn registered any. */
    tools?: unknown
  }
): number {
  const characters =
    (parts.systemPrompt?.length ?? 0) +
    stringifyWithoutBinary(parts.rendered).length +
    stringifyWithoutBinary(parts.tools).length
  const estimated = Math.ceil(characters / APPROX_CHARS_PER_TOKEN)
  const inputLimit = Math.max(0, contextWindowTokens - CLOUD_OUTPUT_RESERVE_TOKENS)
  return Math.min(estimated, Math.floor(inputLimit * MAX_ESTIMATED_SPEND_FRACTION))
}

/**
 * Fold a round's reported prompt usage into the running spend, as a high-water
 * mark rather than a replacement.
 *
 * Both directions of "just take the latest number" are wrong. A provider that
 * reports no usage at all — common on self-hosted OpenAI-compatible endpoints,
 * where `usage` is absent on a streamed completion — would read as zero and
 * reset the budget to a *fresh* window every round, which is worse than the
 * round-0 estimate it replaced. And a provider that reports only uncached input
 * (Anthropic splits `cache_read_input_tokens` out of `input_tokens`) would make
 * the window appear to empty out as caching kicks in. A turn's prompt only ever
 * grows, so the largest figure seen is the one to trust.
 */
export function advanceCloudSpentTokens(current: number, reported: number | undefined): number {
  return reported !== undefined && reported > current ? reported : current
}

/** Below this a string is ordinary text; above it, worth testing for a payload. */
const BINARY_PAYLOAD_MIN_CHARS = 512
/**
 * The fields the three wire shapes put image bytes in: OpenAI's
 * `image_url: "data:image/png;base64,…"`, Chat Completions'
 * `image_url: { url: "data:…" }`, and Anthropic's `source.data: "<base64>"`.
 *
 * Matched on the *field* rather than on what the value looks like. Sniffing the
 * value for a base64 shape was the obvious approach and the wrong one: a long
 * enough run of letters and digits with no spaces is indistinguishable from
 * base64, so a minified bundle or a dump of hashes sitting in a tool result
 * would be dropped from the estimate as if it were an attachment.
 */
const BINARY_PAYLOAD_FIELDS = new Set(['data', 'url', 'image_url', 'b64_json'])

/** `JSON.stringify` with attached-image bytes left out. */
function stringifyWithoutBinary(value: unknown): string {
  if (value === undefined) return ''
  return JSON.stringify(value, (key: string, entry: unknown) => {
    if (typeof entry !== 'string' || entry.length < BINARY_PAYLOAD_MIN_CHARS) return entry
    return BINARY_PAYLOAD_FIELDS.has(key) || entry.startsWith('data:') ? '' : entry
  })
}
