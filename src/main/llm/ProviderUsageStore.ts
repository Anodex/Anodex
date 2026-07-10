import { EventEmitter } from 'node:events'
import type {
  CloudProviderId,
  ProviderRateLimitWindow,
  ProviderUsageSnapshot
} from '@shared/providerUsage.types'

/**
 * In-memory, per-provider usage snapshot, fed from two independent sources
 * that arrive at different times and are merged rather than overwritten:
 *
 * - `recordRateLimit()` — a live rate-limit window read off the provider's
 *   own API response headers, captured mid-generation (see
 *   `AnthropicProvider.ts`). Only ever called for providers whose SDK
 *   actually exposes response headers on a streaming call (Anthropic today).
 * - `recordTodayTokens()` — Anodex's own local tally of tokens sent through
 *   a provider today, computed from `TokenActivityStore` after a generation
 *   completes (see `chat.handlers.ts`). Works identically for every cloud
 *   provider, independent of anything the provider itself reports.
 *
 * Not persisted — this is live session state, gone on restart. A fresh
 * `getUsageSnapshot()` call after restart still returns a correct
 * `todayTokens` figure (recomputed from `TokenActivityStore`'s own
 * persisted data), just with `rateLimit: null` until the next generation.
 */
class ProviderUsageStore extends EventEmitter {
  private snapshots: Partial<Record<CloudProviderId, ProviderUsageSnapshot>> = {}

  getAll(): Partial<Record<CloudProviderId, ProviderUsageSnapshot>> {
    return this.snapshots
  }

  recordRateLimit(provider: CloudProviderId, rateLimit: ProviderRateLimitWindow): void {
    this.merge(provider, { rateLimit })
  }

  recordTodayTokens(provider: CloudProviderId, todayTokens: number): void {
    this.merge(provider, { todayTokens })
  }

  private merge(provider: CloudProviderId, patch: Partial<ProviderUsageSnapshot>): void {
    const existing = this.snapshots[provider]
    const snapshot: ProviderUsageSnapshot = {
      provider,
      rateLimit: existing?.rateLimit ?? null,
      todayTokens: existing?.todayTokens ?? 0,
      ...patch,
      capturedAt: Date.now()
    }
    this.snapshots[provider] = snapshot
    this.emit('change', snapshot)
  }
}

export const providerUsageStore = new ProviderUsageStore()
