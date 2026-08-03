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
