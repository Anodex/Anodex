export type CloudProviderId =
  | 'anthropic'
  | 'openai'
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
 * A cloud provider's live rate-limit window, read from the provider's own
 * API response headers. Only populated for providers whose SDK actually
 * exposes response headers on a streaming call — today that's Anthropic
 * only; OpenAI's Responses API streaming helper doesn't expose the
 * underlying `Response`, so `rateLimit` stays `null` for `openai` even
 * once a generation has run.
 */
export interface ProviderRateLimitWindow {
  tokensLimit: number
  tokensRemaining: number
  /** Epoch ms when this window resets. */
  resetAt: number
}

/**
 * What Anodex knows about a cloud provider's usage right now — a live
 * rate-limit reading (when available) plus Anodex's own local tally of
 * tokens sent through it today, independent of anything the provider
 * reports (used to compare against a user-configured daily cap).
 */
export interface ProviderUsageSnapshot {
  provider: CloudProviderId
  rateLimit: ProviderRateLimitWindow | null
  /** Tokens (input + output) sent through Anodex to this provider today, local calendar day. */
  todayTokens: number
  capturedAt: number
}
