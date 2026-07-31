/**
 * Curated list of xAI Grok models offered in the xAI provider settings.
 *
 * Verified 2026-07-24 via direct fetch of xAI's own docs (not a search
 * summary) and cross-checked against OpenRouter's live public model
 * listing. xAI's catalog includes many dated/beta snapshot variants beyond
 * this curated shortlist — check https://docs.x.ai for the full list.
 */
import type { CloudModelOption } from './cloudModelOption'

export const XAI_MODELS: CloudModelOption[] = [
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    description: 'Recommended flagship — best for hard reasoning and agentic coding.',
    contextWindowTokens: 500_000
  },
  {
    id: 'grok-4.3',
    label: 'Grok 4.3',
    description: 'Prior-generation flagship, still served, with a very large context window.',
    contextWindowTokens: 1_000_000
  },
  {
    id: 'grok-build-0.1',
    label: 'Grok Build',
    description: "xAI's dedicated coding-agent model.",
    contextWindowTokens: 256_000
  }
]

export const DEFAULT_XAI_MODEL = 'grok-4.5'
