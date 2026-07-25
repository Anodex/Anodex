/**
 * Curated list of Mistral AI models offered in the Mistral provider settings.
 *
 * Verified 2026-07-24 via direct fetch of individual model-card pages on
 * Mistral's own docs (not a search summary). `-latest` rolling aliases
 * (e.g. `mistral-large-latest`) are also confirmed to work and always
 * resolve to the newest model in that tier, if preferred over pinning an
 * exact dated id.
 */
import type { CloudModelOption } from './cloudModelOption'

export const MISTRAL_MODELS: CloudModelOption[] = [
  {
    id: 'mistral-large-2512',
    label: 'Mistral Large 3',
    description: 'Most capable Mistral model — best for hard reasoning and coding.',
    contextWindowTokens: 256_000
  },
  {
    id: 'mistral-medium-3-5',
    label: 'Mistral Medium 3.5',
    description: 'Balances intelligence and cost for everyday coding and chat.',
    contextWindowTokens: 256_000
  },
  {
    id: 'codestral-2508',
    label: 'Codestral',
    description: "Mistral's dedicated coding model (text/code only, no vision).",
    contextWindowTokens: 256_000
  },
  {
    id: 'mistral-small-2603',
    label: 'Mistral Small 4',
    description: 'Fastest and cheapest — good for quick, simple tasks.',
    contextWindowTokens: 256_000
  }
]

export const DEFAULT_MISTRAL_MODEL = 'mistral-large-2512'
