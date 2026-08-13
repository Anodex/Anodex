/**
 * Where a reasoning model's thought segment is allowed to become visible text.
 *
 * ## The defect this fixes
 *
 * `LlamaService` promotes a round's thinking segment into visible content
 * whenever that round produced no answer text, so the user is not left staring
 * at an empty bubble. For a model that emits a short answer *inside* its think
 * tags — which several do — that fallback is correct and still applies.
 *
 * It was wrong in one specific case: a round that called a tool. Those rounds
 * routinely produce reasoning and no prose, because the round's visible
 * artifact is the tool card, not a sentence. Promoting there turned every
 * deliberation step into user-facing text, and since each round's contribution
 * is appended to the same reply, a long tool loop concatenated all of them. In
 * chat `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef` that produced replies of
 * 7,300 visible characters of "Let me read the full animate function…",
 * "Actually, let me take a different approach…", backed by 74,779 characters of
 * stored thinking.
 *
 * ## Why this is structural, not textual
 *
 * The obvious-looking fix — strip "Let me…" and similar openers from visible
 * content — was considered and rejected. Those phrases occur in legitimate
 * prose, so matching them deletes real answers, and it leaves the actual cause
 * (a promotion that should never have happened) in place. The channel boundary
 * is decided by what the round *did*, which is knowable exactly, rather than by
 * what its text looks like, which is not.
 *
 * ## Deliberately not handled here
 *
 * Segment *size* is not a promotion criterion. A genuinely long answer emitted
 * entirely inside think tags is rare but real, and refusing to promote it would
 * trade a messy reply for an empty one — a worse failure. Enormous reasoning
 * segments are a budgeting problem, and the right lever is the existing
 * `thoughtTokens` sub-budget (see `GenerationOptions`), which caps them before
 * they are ever produced.
 */

/**
 * Whether a round's thought segment should be shown as that round's answer.
 *
 * @param roundMadeToolCall Whether this round produced tool activity of its
 *   own. When it did, the tool card is the round's visible output and there is
 *   no empty bubble to avoid, so the segment belongs in the thinking channel.
 */
export function shouldPromoteThinkingToAnswer(
  segment: string,
  roundMadeToolCall: boolean
): boolean {
  if (!segment.trim()) return false
  return !roundMadeToolCall
}

/** Accumulate thought segments across rounds, blank-line separated. */
export function appendThinking(existing: string, segment: string): string {
  const trimmed = segment.trim()
  if (!trimmed) return existing
  return existing ? `${existing}\n\n${trimmed}` : trimmed
}
