/**
 * How long "Test connection" waits before giving up on a provider.
 *
 * Both SDKs default to ten minutes, which is a reasonable ceiling for a real
 * generation and a terrible one for a reachability check: a black-holed
 * endpoint — a mistyped base URL, a captive portal, a proxy that accepts the
 * connection and never answers — left the button spinning with no way to tell
 * that from a slow provider.
 *
 * Fifteen seconds is far longer than a metadata lookup ever legitimately takes
 * and short enough that failure reads as failure. Shared so a provider added
 * later inherits it rather than the SDK default, which is how every provider
 * came to have this.
 */
export const VERIFY_KEY_TIMEOUT_MS = 15_000

/**
 * How long a context-compaction summary waits before the turn gives up on it.
 *
 * Same SDK ten-minute default, and a worse fit again: this call runs *inside* a
 * turn, from `boundHistoryForStatelessProvider`, and no abort signal is plumbed
 * through the `RollingSummarizer` contract — so a stalled compaction held the
 * turn open for most of its own fifteen-minute budget with the Stop button
 * unable to touch it.
 *
 * Failing is cheap here, which is what makes a tight bound right: every caller
 * treats `null` as "no summary available" and falls back to dropping the older
 * turns, so a slow summary costs the turn far more than a missing one does.
 */
export const COMPACTION_TIMEOUT_MS = 60_000
