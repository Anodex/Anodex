import type { AppSettings, ProviderSettings } from './settings.types'

/**
 * The reply ceiling configured for whichever provider will handle the next
 * turn, or `undefined` when the user has not set one.
 *
 * This replaced a single global `generation.maxTokens` applied to every
 * backend at once. That was wrong in both directions: a number chosen to bound
 * spend on a cloud provider has no business capping a local model that costs
 * nothing, and a number chosen for a local model's context has no relation to
 * what a cloud request should cost.
 *
 * `undefined` deliberately means "the provider decides", and the two kinds of
 * provider decide differently:
 *
 * - **Local** — `resolveLocalOutputBudget` gives the turn everything its
 *   measured context leaves room for. There is nothing to bound and no cost to
 *   save, so this is the default (see `LocalProviderSettings`).
 * - **Cloud** — each provider falls back to its own `DEFAULT_MAX_TOKENS`,
 *   because these APIs require an explicit ceiling on every request.
 */
export function activeMaxResponseTokens(settings: AppSettings): number | undefined {
  return providerMaxResponseTokens(settings.provider, settings.provider.active)
}

export function providerMaxResponseTokens(
  provider: ProviderSettings,
  id: ProviderSettings['active']
): number | undefined {
  const configured = provider[id]?.maxResponseTokens
  return typeof configured === 'number' && configured > 0 ? configured : undefined
}
