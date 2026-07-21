import type { CriticalThinkingProvider } from '@shared/criticalThinking.types'
import { cloudContextWindowTokens } from '@shared/contextBudget'

const MAX_PROMPT_CHARS = 80_000
const MAX_EVIDENCE_CHARS = 36_000
const MAX_OUTPUT_TOKENS = 4_096
const MIN_OUTPUT_TOKENS = 768
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
  maxQuestionChars: number
  maxPlanChars: number
  maxFindingChars: number
  maxEvidenceChars: number
}

/**
 * Reserve reply and system-prompt space before allocating synthesis input.
 * Local 4K/8K contexts therefore receive a much smaller packet than cloud
 * models, while large contexts retain the existing 36,000-character ceiling.
 */
export function criticalThinkingSynthesisLimits(
  contextTokens: number
): CriticalThinkingSynthesisLimits {
  const safeContextTokens = Math.max(2_048, contextTokens)
  const maxOutputTokens = Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Math.floor(safeContextTokens * 0.25))
  )
  const systemReserveTokens = Math.min(2_048, Math.max(768, Math.floor(safeContextTokens * 0.125)))
  const availableInputTokens = Math.max(
    1_024,
    safeContextTokens - maxOutputTokens - systemReserveTokens
  )
  const maxPromptChars = Math.min(MAX_PROMPT_CHARS, availableInputTokens * APPROX_CHARS_PER_TOKEN)
  const minVisibleOutputTokens = Math.ceil(maxOutputTokens * MIN_VISIBLE_OUTPUT_FRACTION)
  const thoughtTokens = Math.max(0, maxOutputTokens - minVisibleOutputTokens)

  return {
    contextTokens: safeContextTokens,
    maxOutputTokens,
    thoughtTokens,
    maxPromptChars,
    maxQuestionChars: Math.min(4_000, Math.floor(maxPromptChars * 0.1)),
    maxPlanChars: Math.min(4_000, Math.floor(maxPromptChars * 0.1)),
    maxFindingChars: Math.min(8_000, Math.floor(maxPromptChars * 0.12)),
    maxEvidenceChars: Math.min(MAX_EVIDENCE_CHARS, Math.floor(maxPromptChars * 0.58))
  }
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
