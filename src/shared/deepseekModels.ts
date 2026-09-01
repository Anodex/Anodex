/**
 * Curated list of DeepSeek models offered in the DeepSeek provider settings.
 *
 * Verified 2026-07-24 via direct fetch of DeepSeek's own pricing/docs page
 * (not a search summary), cross-checked against OpenRouter's live public
 * model listing. The older `deepseek-chat`/`deepseek-reasoner` aliases have
 * already passed their deprecation cutoff as of this writing — deliberately
 * not listed here even as legacy options.
 *
 * Re-verified 2026-08-31 against api-docs.deepseek.com: both ids current, both
 * 1M context, base URL still `api.deepseek.com` with no `/v1`. `deepseek-v4-flash`
 * is now DeepSeek-V4-Flash-0731 and `deepseek-v4-pro` DeepSeek-V4-Pro-0813,
 * which the ids resolve to on their own.
 *
 * `deepseek-v4-flash-vision-exp` exists and is deliberately not listed. It is
 * experimental, and Anodex's cloud-vision gate (`ChatComposer`) does not cover
 * DeepSeek, so offering it would advertise a model whose one distinguishing
 * capability this app cannot use.
 */
import type { CloudModelOption } from './cloudModelOption'

export const DEEPSEEK_MODELS: CloudModelOption[] = [
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: 'Current general-purpose model — supports thinking and non-thinking modes.',
    contextWindowTokens: 1_048_576
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'Higher-tier current model for harder reasoning and coding tasks.',
    contextWindowTokens: 1_048_576
  }
]

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
