import type { CriticalThinkingProvider } from '@shared/criticalThinking.types'
import { cloudContextWindowTokens } from '@shared/contextBudget'

/**
 * Absolute rails on prompt size, not the working limit.
 *
 * Everything below is derived from the context the model actually has, which is
 * the right shape -- but these two ceilings were low enough to cancel that out.
 * Measured on a real 65,536-token run: the context allowed 141,312 prompt
 * characters and the ceiling admitted 80,000; the evidence share allowed 46,400
 * and the ceiling admitted 36,000. The run had gathered 119,843 characters of
 * passages across 57 pages, so **30% of its own evidence reached the model** --
 * and its steps kept reporting facts as missing that were sitting in the
 * evidence store unread.
 *
 * They are now high enough that the context share governs on any window a local
 * model realistically runs, and they remain only as a guard against a very
 * large context producing an absurd prompt.
 */
const MAX_PROMPT_CHARS = 240_000
const MAX_EVIDENCE_CHARS = 140_000
/**
 * A research report is a long-form artifact, and a reasoning-tuned model pays
 * for it twice: once in hidden thinking, once in the report itself. Measured
 * on a real 32K run, one synthesis produced 16,658 characters of thinking
 * beside 6,341 characters of report before hitting its ceiling — thinking
 * alone was most of the budget, so the report arrived truncated.
 *
 * The old ceiling was 8,192, and the caller passes the user's *chat reply*
 * setting as the request, so a long report was sized like a chat message
 * while ~6,000 tokens of context headroom went unused. These now let a run
 * claim the room its context actually has.
 */
const MAX_OUTPUT_TOKENS = 16_384
const MIN_OUTPUT_TOKENS = 768
/** Share of the context a report may claim for output, and the hard ceiling on that share. */
const OUTPUT_CONTEXT_SHARE = 0.4
const MAX_OUTPUT_CONTEXT_SHARE = 0.45
const APPROX_CHARS_PER_TOKEN = 3
/**
 * A reasoning-tuned local model can spend nearly all of `maxOutputTokens` on
 * hidden thinking before writing anything visible — the exact live 8K
 * Critical Thinking failure produced 14 verified sources but only a
 * 175-character report for this reason (P0-E). Guaranteeing at least this
 * fraction for visible report text, regardless of the total's size, is a
 * starting hypothesis to tune against a real wrapper/tokenizer, not a proven
 * production constant.
 */
const MIN_VISIBLE_OUTPUT_FRACTION = 0.6
/**
 * Floor on the share of the prompt that stays divisible between the inputs,
 * however large the caller says its scaffold is. The four input shares sum to
 * 90%, so this also keeps a little slack for the scaffold's own measurement
 * being approximate.
 */
const MIN_ALLOCATABLE_FRACTION = 0.25

export interface CriticalThinkingSynthesisLimits {
  contextTokens: number
  maxOutputTokens: number
  /**
   * Sub-budget within `maxOutputTokens` for hidden reasoning — see
   * `GenerationOptions.thoughtTokens`'s doc comment. At most
   * `1 - MIN_VISIBLE_OUTPUT_FRACTION` of the total, so at least
   * `MIN_VISIBLE_OUTPUT_FRACTION` always stays reserved for the visible
   * reply once the reasoning segment closes.
   */
  thoughtTokens: number
  maxPromptChars: number
  /**
   * Room the shares below were allocated from: `maxPromptChars` less the
   * scaffold the caller said it needs. Reported so a caller can see why its
   * shares are smaller than the raw prompt budget.
   */
  allocatablePromptChars: number
  maxQuestionChars: number
  maxPlanChars: number
  maxFindingChars: number
  maxEvidenceChars: number
}

/**
 * Reserve reply and system-prompt space before allocating synthesis input.
 * Local 4K/8K contexts therefore receive a much smaller packet than cloud
 * models, while large contexts retain the existing 36,000-character ceiling.
 *
 * `scaffoldChars` is the fixed cost of the prompt the caller is about to build
 * -- its instruction block and structural text, everything that is neither an
 * input nor the evidence. Passing it matters because the shares below are
 * useless unless the caller can actually spend them. `runSynthesis` sizes the
 * evidence packet with
 *
 *   min(maxEvidenceChars, maxPromptChars - promptWithoutEvidence.length)
 *
 * so with the scaffold outside the budget, its whole cost lands on the
 * evidence -- the one input that cannot be reconstructed from anything else.
 * Measured against the real synthesis prompt (~2,100 scaffold characters):
 *
 *   ctx  4,096 -> share  2,583, delivered    271  (10%)
 *   ctx  8,192 -> share  6,058, delivered  4,944  (82%)
 *   ctx 16,384 -> share 13,542, delivered full
 *
 * The distortion is worst where there is least to give, so the configurations
 * that break are the modest ones. A 4K run was asking a model to write a cited
 * research report from 271 characters of evidence; four stored 8K runs
 * (2026-09-04) came in at 4,873-4,901 packet characters and every one of them
 * reported the passages as too fragmentary to conclude anything -- an accurate
 * description of what it was given.
 *
 * Allocating the shares over what remains after the scaffold makes the
 * declared share the delivered share on every context. It defaults to 0 so a
 * caller that builds a smaller prompt keeps the previous arithmetic exactly.
 */
export function criticalThinkingSynthesisLimits(
  contextTokens: number,
  requestedOutputTokens?: number,
  scaffoldChars = 0
): CriticalThinkingSynthesisLimits {
  const safeContextTokens = Math.max(2_048, contextTokens)
  const requested =
    requestedOutputTokens !== undefined &&
    Number.isFinite(requestedOutputTokens) &&
    requestedOutputTokens > 0
      ? Math.floor(requestedOutputTokens)
      : 0
  // The caller's request is a floor, not a ceiling: it carries the user's
  // chat-reply preference, which has no bearing on how much room a cited
  // report needs. A report claims its context share when that is larger, and
  // the context share is what protects a small local window from being
  // handed an output budget that leaves no room for the evidence.
  const maxOutputTokens = Math.min(
    MAX_OUTPUT_TOKENS,
    Math.floor(safeContextTokens * MAX_OUTPUT_CONTEXT_SHARE),
    Math.max(MIN_OUTPUT_TOKENS, requested, Math.floor(safeContextTokens * OUTPUT_CONTEXT_SHARE))
  )
  const systemReserveTokens = Math.min(2_048, Math.max(768, Math.floor(safeContextTokens * 0.125)))
  const availableInputTokens = Math.max(
    1_024,
    safeContextTokens - maxOutputTokens - systemReserveTokens
  )
  const maxPromptChars = Math.min(MAX_PROMPT_CHARS, availableInputTokens * APPROX_CHARS_PER_TOKEN)
  // Never let the scaffold claim the entire prompt: a caller whose fixed text
  // exceeds the window still gets a real, if small, share to divide, and the
  // truncation shows up in the inputs rather than as a silently empty packet.
  // The four input shares below sum to 100% of this, so the whole prompt comes
  // to exactly `scaffoldChars + allocatablePromptChars`. Before the scaffold
  // was accounted for they summed to 90% and the caller quietly spent the
  // remaining 10% on evidence; keeping that slack now would hand the evidence
  // less than it used to get on the same context, which is the opposite of the
  // point.
  const allocatablePromptChars = Math.max(
    Math.floor(maxPromptChars * MIN_ALLOCATABLE_FRACTION),
    maxPromptChars - Math.max(0, Math.floor(scaffoldChars))
  )
  const minVisibleOutputTokens = Math.ceil(maxOutputTokens * MIN_VISIBLE_OUTPUT_FRACTION)
  const thoughtTokens = Math.max(0, maxOutputTokens - minVisibleOutputTokens)

  return {
    contextTokens: safeContextTokens,
    maxOutputTokens,
    thoughtTokens,
    maxPromptChars,
    allocatablePromptChars,
    maxQuestionChars: Math.min(4_000, Math.floor(allocatablePromptChars * 0.1)),
    maxPlanChars: Math.min(4_000, Math.floor(allocatablePromptChars * 0.1)),
    maxFindingChars: Math.min(8_000, Math.floor(allocatablePromptChars * 0.12)),
    maxEvidenceChars: Math.min(MAX_EVIDENCE_CHARS, Math.floor(allocatablePromptChars * 0.68))
  }
}

/**
 * How many characters of evidence a prompt can actually carry.
 *
 * Every caller was computing this inline, and each one got the same thing
 * subtly wrong in the same way, so the rule lives here once.
 *
 * Two facts decide it. The first is physical: whatever the rest of the prompt
 * did not use is room the evidence can have. The second is that the other
 * inputs are *capped*, not fixed -- a short question or a thin set of findings
 * leaves room behind, and handing that room to the evidence is right, because
 * the evidence is the one input nothing else in the prompt can stand in for.
 * `maxEvidenceChars` is therefore a floor the budget guarantees, not a ceiling
 * to stop at; the scaffold accounting in `criticalThinkingSynthesisLimits` is
 * what makes the room reliably exist.
 *
 * `maxShare` is for a prompt that deliberately wants less than the whole
 * report's packet -- a per-step section reasons about one step, so it caps its
 * growth at a share of the run's budget rather than taking the room. Omit it
 * to take the room.
 */
export function evidencePacketChars(
  limits: CriticalThinkingSynthesisLimits,
  promptWithoutEvidenceChars: number,
  maxShare?: number
): number {
  const room = Math.max(0, limits.maxPromptChars - Math.max(0, promptWithoutEvidenceChars))
  const ceiling =
    maxShare === undefined
      ? MAX_EVIDENCE_CHARS
      : Math.min(MAX_EVIDENCE_CHARS, Math.floor(limits.maxEvidenceChars * maxShare))
  return Math.min(ceiling, room)
}

export function criticalThinkingContextTokens(
  provider: CriticalThinkingProvider,
  model: string | null,
  localContextTokens: number | undefined
): number {
  if (provider === 'local') return localContextTokens ?? 4_096
  return cloudContextWindowTokens(provider, model ?? '')
}

/** Keep a list's item boundaries while applying one aggregate character cap. */
export function boundPromptItems(items: string[], maxChars: number): string[] {
  const bounded: string[] = []
  let remaining = Math.max(0, maxChars)
  for (const item of items) {
    if (remaining <= 0) break
    const trimmed = item.trim()
    if (!trimmed) continue
    const value = trimmed.length <= remaining ? trimmed : truncate(trimmed, remaining)
    if (value) bounded.push(value)
    remaining -= value.length
  }
  return bounded
}

export function truncatePromptText(value: string, maxChars: number): string {
  return truncate(value.trim(), Math.max(0, maxChars))
}

function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  if (maxChars === 1) return '…'
  return `${value.slice(0, maxChars - 1)}…`
}
