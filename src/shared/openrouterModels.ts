/**
 * Curated list of models offered in the OpenRouter provider settings.
 * OpenRouter is a model-routing gateway — every id is `vendor/model-name`
 * rather than a name OpenRouter itself defines, and it's the one provider
 * here where a user is at least as likely to want to type a custom id (any
 * model OpenRouter lists) as pick from this short curated shortlist. A `~`
 * prefix (e.g. `~openai/gpt-latest`) denotes a "latest alias" that always
 * resolves to that vendor's newest flagship.
 *
 * Verified 2026-07-24 directly against OpenRouter's own live, public,
 * no-auth-required model listing (`GET /api/v1/models`) — these are
 * confirmed-present examples as of that check, not guessed.
 */
import type { CloudModelOption } from './cloudModelOption'

export const OPENROUTER_MODELS: CloudModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5 (OpenRouter)',
    description: 'Anthropic Claude Sonnet 5, routed through OpenRouter.',
    contextWindowTokens: 200_000
  },
  {
    id: 'openai/gpt-5.6',
    label: 'GPT-5.6 (OpenRouter)',
    description: 'OpenAI GPT-5.6, routed through OpenRouter.',
    contextWindowTokens: 256_000
  },
  {
    id: 'google/gemini-3.6-flash',
    label: 'Gemini 3.6 Flash (OpenRouter)',
    description: 'Google Gemini 3.6 Flash, routed through OpenRouter.',
    contextWindowTokens: 1_048_576
  },
  {
    id: 'meta-llama/llama-4-maverick',
    label: 'Llama 4 Maverick (OpenRouter)',
    description: "Meta's open Llama 4 Maverick, routed through OpenRouter.",
    contextWindowTokens: 128_000
  }
]

export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5'
