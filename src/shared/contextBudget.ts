import type { CloudModelOption } from './cloudModelOption'
import { ANTHROPIC_MODELS } from './anthropicModels'
import { OPENAI_MODELS } from './openaiModels'
import { GOOGLE_MODELS } from './googleModels'
import { XAI_MODELS } from './xaiModels'
import { DEEPSEEK_MODELS } from './deepseekModels'
import { MISTRAL_MODELS } from './mistralModels'
import { GROQ_MODELS } from './groqModels'
import { OPENROUTER_MODELS } from './openrouterModels'
import { KIMI_MODELS } from './kimiModels'
import { QWEN_MODELS } from './qwenModels'

/**
 * Shared context-budget knobs used by both the main-process assembler and the
 * renderer's projected context meter.
 *
 * These values describe Anodex's model-facing projection, not the persisted
 * chat transcript. Keeping them shared prevents the UI from displaying a
 * different context story than the engine actually uses.
 */

export const RESERVED_NON_HISTORY_FRACTION = 0.2
export const MIN_RESERVED_NON_HISTORY_TOKENS = 512
export const MAX_RESERVED_NON_HISTORY_TOKENS = 8192

/**
 * Manual compaction keeps this many newest turns verbatim. The summary covers
 * everything older, so the user can clean the context before a new phase
 * without sacrificing the immediate back-and-forth that often contains
 * unresolved details.
 */
export const MANUAL_COMPACTION_RECENT_TURNS = 6

/**
 * Fraction of the history budget the balanced Context Ledger policy may replay verbatim.
 *
 * The retired greedy policy let history fill the whole budget, so a rebuilt
 * session sat near the compaction trigger with almost no room to refill. The
 * balanced policy caps replay at this fraction: older turns are summarized
 * instead of replayed, the rebuilt KV cache starts low, and the meter resets
 * refills turn by turn — the opencode-style context-epoch behaviour. Shared so
 * the engine and the renderer's projection meter can never disagree about what
 * the replay ceiling is.
 *
 * `null` (in settings) means no cap — the historical greedy behaviour.
 */
export const DEFAULT_RECALL_WINDOW_FRACTION = 0.4

/**
 * Maximum remembered output per past tool call when rebuilding model context.
 * Full tool details can remain in the UI transcript; this is the compact
 * model-facing replay limit.
 */
export const MAX_MODEL_TOOL_RESULT_CHARS = 1_200

/**
 * Conservative context-window fallback for a cloud model with no known
 * `contextWindowTokens` entry (e.g. a custom/typed-in model override). Well
 * below every current OpenAI/Anthropic model's real window so an unrecognized
 * model still gets bounded instead of replaying history unboundedly.
 */
export const DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS = 128_000

/** Every non-local provider `cloudContextWindowTokens` can look up a catalog for. */
export type CloudProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'mistral'
  | 'groq'
  | 'openrouter'
  | 'azure'
  | 'kimi'
  | 'qwen'

/**
 * `azure` deliberately maps to an empty catalog: Azure has no fixed model
 * catalog (a customer names their own deployment), so a lookup here always
 * falls through to `DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS` rather than being
 * a special case in `cloudContextWindowTokens` itself.
 */
const CLOUD_MODEL_CATALOGS: Record<CloudProvider, CloudModelOption[]> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  google: GOOGLE_MODELS,
  xai: XAI_MODELS,
  deepseek: DEEPSEEK_MODELS,
  mistral: MISTRAL_MODELS,
  groq: GROQ_MODELS,
  openrouter: OPENROUTER_MODELS,
  azure: [],
  kimi: KIMI_MODELS,
  qwen: QWEN_MODELS
}

/** Conservative context window for a configured cloud model. */
export function cloudContextWindowTokens(provider: CloudProvider, modelId: string): number {
  const models = CLOUD_MODEL_CATALOGS[provider] ?? []
  return (
    models.find((model) => model.id === modelId)?.contextWindowTokens ??
    DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS
  )
}

/** Non-history token reservation for the given context window. */
export function reservedNonHistoryTokens(contextSize: number): number {
  return Math.min(
    MAX_RESERVED_NON_HISTORY_TOKENS,
    Math.max(
      MIN_RESERVED_NON_HISTORY_TOKENS,
      Math.round(contextSize * RESERVED_NON_HISTORY_FRACTION)
    )
  )
}
