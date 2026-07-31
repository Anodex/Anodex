/**
 * Curated list of Alibaba Cloud Qwen models offered in the Qwen provider
 * settings, accessed through DashScope's OpenAI-compatible endpoint (see
 * `OpenAiCompatibleProvider.ts`). Distinct from Anodex's LOCAL Qwen GGUF
 * support (`local` provider, `src/main/llama/`) — this is the hosted cloud
 * API for the same model family, a different provider entirely.
 *
 * Partially verified 2026-07-24 via direct fetch of Alibaba Cloud's own
 * OpenAI-compatibility docs: `qwen-max`/`qwen-plus`/`qwen-turbo` are
 * confirmed as real, currently-referenced model ids (quoted directly in
 * Alibaba's docs, not from a search-engine summary). Context window sizes
 * were NOT confirmed by that fetch — the figures below are estimates, not
 * verified facts. A separate, lower-confidence source also referenced
 * newer "Qwen3.7-Max"-style dated models and a workspace-id-in-URL
 * endpoint pattern that structurally contradicts the well-established
 * simpler endpoint used below — not adopted here pending clearer
 * confirmation. Cross-check against
 * https://www.alibabacloud.com/help/en/model-studio before relying on
 * either the model ids or the endpoint shape long after this date.
 */
import type { CloudModelOption } from './cloudModelOption'

export const QWEN_MODELS: CloudModelOption[] = [
  {
    id: 'qwen-max',
    label: 'Qwen Max',
    description: 'Most capable Qwen model — best for hard reasoning and agentic coding.',
    contextWindowTokens: 131_072
  },
  {
    id: 'qwen-plus',
    label: 'Qwen Plus',
    description: 'Balances intelligence and cost for everyday coding and chat.',
    contextWindowTokens: 131_072
  },
  {
    id: 'qwen-turbo',
    label: 'Qwen Turbo',
    description: 'Fastest and cheapest — good for quick, simple tasks.',
    contextWindowTokens: 131_072
  }
]

export const DEFAULT_QWEN_MODEL = 'qwen-max'
