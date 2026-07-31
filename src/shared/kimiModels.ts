/**
 * Curated list of Moonshot AI "Kimi" models offered in the Kimi provider
 * settings.
 *
 * Verified 2026-07-24 via direct fetch of Moonshot's own docs (not a search
 * summary), cross-checked against OpenRouter's live public model listing.
 * The entire old `kimi-k2`/`kimi-latest`/`kimi-thinking-preview` series and
 * all `moonshot-v1-*` legacy models are already discontinued or sunsetting
 * (`kimi-k2.5` fully shuts down 2026-08-31) — deliberately not listed here.
 * Two API quirks worth knowing if this provider's code is ever extended:
 * the `thinking` param must be passed via the SDK's `extra_body`, and
 * `partial` (prefix completion) lives on a message inside `messages`, not
 * as a request-level field.
 */
import type { CloudModelOption } from './cloudModelOption'

export const KIMI_MODELS: CloudModelOption[] = [
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    description: 'Current flagship — native vision, thinking and non-thinking modes.',
    contextWindowTokens: 1_048_576
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    description: "Moonshot's dedicated coding model.",
    contextWindowTokens: 256_000
  },
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    description: 'Balanced general-purpose model — text, image, and video input.',
    contextWindowTokens: 256_000
  }
]

export const DEFAULT_KIMI_MODEL = 'kimi-k3'
