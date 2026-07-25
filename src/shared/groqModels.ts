/**
 * Curated list of models offered in the Groq provider settings. Groq hosts
 * fast inference for other companies' open-weight models rather than
 * training its own, so these ids name the hosted model, not "Groq".
 *
 * Verified 2026-07-24 via direct fetch of Groq's own "Production Models"
 * table (not a search summary) — hosted-model availability changes more
 * often here than most providers, so re-check
 * https://console.groq.com/docs/models before relying on an exact id long
 * after this date. A few standard OpenAI request params are explicitly
 * unsupported here and return an error: `logprobs`, `logit_bias`,
 * `top_logprobs`, `messages[].name`; `n` must equal 1.
 */
import type { CloudModelOption } from './cloudModelOption'

export const GROQ_MODELS: CloudModelOption[] = [
  {
    id: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B (Groq)',
    description: 'Meta Llama 3.3 70B served at very high inference speed.',
    contextWindowTokens: 131_072
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (Groq)',
    description: "OpenAI's open-weight 120B model served at very high inference speed.",
    contextWindowTokens: 131_072
  },
  {
    id: 'openai/gpt-oss-20b',
    label: 'GPT-OSS 20B (Groq)',
    description: "OpenAI's open-weight 20B model served at very high inference speed.",
    contextWindowTokens: 131_072
  },
  {
    id: 'llama-3.1-8b-instant',
    label: 'Llama 3.1 8B Instant (Groq)',
    description: 'Fastest and cheapest — good for quick, simple tasks.',
    contextWindowTokens: 131_072
  }
]

export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile'
