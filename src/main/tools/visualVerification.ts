/**
 * Shared predicates for "did this reply claim something renders, and is that
 * claim backed by a screenshot taken after the change?"
 *
 * Two callers need the same judgement from different data:
 *
 * - `boundedChatRunner` checks a finished reply against the ordered `ToolCall`
 *   list for the whole bounded response, and appends a correction.
 * - `finish_goal` (`agentTools.ts`) checks a run's completion summary against
 *   the current turn's evidence ledger, and refuses outright.
 *
 * The text judgement is identical and lives here once; the evidence lookups
 * differ genuinely (an ordered array versus a running ledger) and stay with
 * their callers rather than being forced into one signature.
 *
 * The rule both enforce is about **ordering**, not presence. In chat
 * `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef` the model was asked to "confirm by
 * using vision", called `inspect_visual` once at the very start of the turn,
 * then edited the file and reported progress. A screenshot taken before an
 * edit says nothing about the state after it, so "an inspection happened" is
 * not the question — "did one happen after the last change" is.
 */

/**
 * Subjects that only make sense as claims about rendered output. Claims about
 * source code are excluded deliberately: static reading can legitimately
 * support "the function is now defined", and flagging that would make the
 * correction noise.
 */
const VISUAL_SUBJECT =
  /\b(?:canvas|render(?:s|ed|ing)?|page|screen|display(?:s|ed)?|visual|ui|sandbox|animation|scene)\b/i

/** Phrasings that assert the visual subject is now good. */
const VISUAL_SUCCESS =
  /\b(?:now works?|now renders?|now displays?|is working|is fixed|fixed it|working correctly|displays? correctly|renders? correctly|verified|confirmed)\b/i

/**
 * Hedges that already concede the claim is untested. A reply that says so
 * needs no correction — it is being honest, and appending a warning to an
 * honest caveat reads as the system not having understood it.
 */
const ALREADY_HEDGED =
  /\b(?:not verified|unverified|could not confirm|couldn't confirm|still broken|not yet|untested)\b/i

/** Whether `text` asserts that something visual now works. */
export function claimsVisualSuccess(text: string): boolean {
  if (ALREADY_HEDGED.test(text)) return false
  return VISUAL_SUBJECT.test(text) && VISUAL_SUCCESS.test(text)
}
