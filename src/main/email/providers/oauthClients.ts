import type { EmailAccount } from '@shared/email.types'
import {
  authorizeWithPkce,
  refreshOAuthTokens,
  type OAuthClientConfig,
  type OAuthTokens
} from '../oauth'
import { emailAuthStore } from '../EmailAuthStore'

/**
 * Built-in OAuth client IDs, supplied at build time.
 *
 * Native apps are public clients (RFC 8252), so shipping a client ID is the
 * normal desktop pattern and PKCE — not a secret — is what protects the flow.
 * When these are unset the app falls back to a per-account client ID the user
 * pastes in Settings, which is how the Gmail integration worked before.
 *
 * Read lazily rather than at module load so a packaged build can inject them
 * through the environment without a rebuild of this module's constants.
 */
function builtInClientId(provider: 'gmail' | 'microsoft'): string {
  const value =
    provider === 'gmail'
      ? process.env.ANODEX_GOOGLE_CLIENT_ID
      : process.env.ANODEX_MICROSOFT_CLIENT_ID
  return value?.trim() ?? ''
}

/**
 * `gmail.modify` rather than `gmail.readonly`: archiving, starring, and
 * marking read all go through label mutations, which readonly forbids. It
 * still cannot permanently delete mail — that needs the separate
 * `mail.google.com` scope, which Anodex deliberately does not request.
 */
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send'
]

const MICROSOFT_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read'
]

/** True when one-click linking is available without the user registering a client. */
export function hasBuiltInClient(provider: 'gmail' | 'microsoft'): boolean {
  return builtInClientId(provider) !== ''
}

export function oauthConfigFor(
  provider: 'gmail' | 'microsoft',
  overrides: { clientId?: string; clientSecret?: string } = {}
): OAuthClientConfig {
  const clientId = overrides.clientId?.trim() || builtInClientId(provider)

  if (provider === 'gmail') {
    return {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: GMAIL_SCOPES,
      clientId,
      clientSecret: overrides.clientSecret,
      // `access_type=offline` + `prompt=consent` is what makes Google return a
      // refresh token; without it a re-authorization yields access-only tokens
      // and the account silently dies an hour later.
      extraAuthParams: { access_type: 'offline', prompt: 'consent' }
    }
  }

  return {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: MICROSOFT_SCOPES,
    clientId,
    clientSecret: overrides.clientSecret,
    extraAuthParams: { prompt: 'select_account' },
    // Entra only allows arbitrary loopback ports under `http://localhost`.
    redirectHost: 'localhost'
  }
}

/**
 * How close to expiry a cached access token is treated as already spent.
 *
 * `oauth.ts` has already backed the stored `expiresAt` off 30 seconds from what
 * the provider stated, so the real margin is this plus that — comfortably more
 * than a slow request needs to reach the server while still valid.
 */
const REFRESH_MARGIN_MS = 60_000

/**
 * Refreshes currently in flight, keyed by account id.
 *
 * Every request either adapter makes calls `accessTokenFor`, and both open a
 * thread by fetching its messages through `Promise.all` — so reading one
 * twelve-message thread on an expired token used to start twelve refreshes at
 * once, each sending the same refresh token. That is not merely wasteful:
 * Entra rotates refresh tokens and invalidates the previous one as soon as it
 * is redeemed, so the first request through would kill the token the other
 * eleven were still using, and those failed with `invalid_grant` while the
 * account looked fine. Google rotates under some client configurations too.
 *
 * Collapsing them to one shared promise per account makes the refresh happen
 * exactly once however many callers are waiting on it.
 */
const inFlightRefreshes = new Map<string, Promise<OAuthTokens>>()

/**
 * The OAuth provider backing an account, or a refusal.
 *
 * `EmailProvider` includes `imap`, which authenticates with a password and has
 * no token endpoint. The previous `=== 'microsoft' ? … : 'gmail'` quietly filed
 * an IMAP account under Google and would have sent its credentials to Google's
 * token URL. Nothing routes an IMAP account here today; saying so explicitly is
 * what keeps that true.
 */
function oauthProviderFor(account: EmailAccount): 'gmail' | 'microsoft' {
  if (account.provider === 'gmail' || account.provider === 'microsoft') return account.provider
  throw new Error(`${account.address} is an IMAP account and does not use OAuth.`)
}

/** Runs the browser authorization for a not-yet-linked account. */
export function authorizeProvider(
  provider: 'gmail' | 'microsoft',
  overrides: { clientId?: string; clientSecret?: string } = {}
): Promise<OAuthTokens> {
  const config = oauthConfigFor(provider, overrides)
  if (!config.clientId) {
    throw new Error(
      `No ${provider === 'gmail' ? 'Google' : 'Microsoft'} OAuth client ID is available. ` +
        'Add one under Advanced in Settings -> Email, or use an app password instead.'
    )
  }
  return authorizeWithPkce(config)
}

/**
 * Returns a usable access token for an OAuth account, refreshing and
 * re-persisting it when the cached one is close enough to expiry to be unsafe.
 *
 * Called on every request either OAuth adapter makes, so the common path — a
 * token with time left — must stay a single synchronous read, and the uncommon
 * one must not multiply when callers arrive together (see `inFlightRefreshes`).
 */
export async function accessTokenFor(account: EmailAccount): Promise<string> {
  const tokens = emailAuthStore.getToken<OAuthTokens>(account.id)
  if (!tokens) {
    throw new Error(`${account.address} is not connected. Reconnect it in Settings -> Email.`)
  }
  if (tokens.expiresAt > Date.now() + REFRESH_MARGIN_MS) return tokens.accessToken
  if (!tokens.refreshToken) {
    throw new Error(
      `${account.address} needs to be reconnected — its session expired and no refresh token is stored.`
    )
  }

  const refreshed = await sharedRefresh(account, tokens.refreshToken)
  return refreshed.accessToken
}

/**
 * One refresh per account at a time. Late arrivals join the one already
 * running rather than starting their own; the entry is cleared once it settles,
 * so the next expiry refreshes again and a failed attempt can be retried
 * immediately rather than being remembered as broken.
 */
function sharedRefresh(account: EmailAccount, refreshToken: string): Promise<OAuthTokens> {
  const existing = inFlightRefreshes.get(account.id)
  if (existing) return existing

  const running = performRefresh(account, refreshToken).finally(() => {
    inFlightRefreshes.delete(account.id)
  })
  inFlightRefreshes.set(account.id, running)
  return running
}

async function performRefresh(account: EmailAccount, refreshToken: string): Promise<OAuthTokens> {
  const config = oauthConfigFor(oauthProviderFor(account), {
    clientId: account.oauthClientId,
    clientSecret: emailAuthStore.getClientSecret(account.id) ?? undefined
  })

  let refreshed: OAuthTokens
  try {
    refreshed = await refreshOAuthTokens(config, refreshToken)
  } catch (error) {
    throw new Error(refreshFailureMessage(account, error))
  }
  emailAuthStore.setToken(account.id, refreshed)
  return refreshed
}

/**
 * What the user is told when a refresh fails, which turns on whether trying
 * again could ever work.
 *
 * `invalid_grant` is the one answer that never recovers on its own — the
 * refresh token has been revoked, has expired, or was rotated away — and it is
 * the only case where "reconnect the account" is the right instruction.
 * Everything else is most likely the network or the provider having a moment,
 * where telling someone to re-link their mailbox sends them to redo work that
 * was never broken.
 */
function refreshFailureMessage(account: EmailAccount, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/invalid_grant/i.test(detail)) {
    return `${account.address} needs to be reconnected — the stored session was rejected. Reconnect it in Settings -> Email.`
  }
  return `Could not renew the session for ${account.address}: ${detail}`
}
