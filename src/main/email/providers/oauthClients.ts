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
 * re-persisting it when the cached one is within a minute of expiry.
 */
export async function accessTokenFor(account: EmailAccount): Promise<string> {
  const provider = account.provider === 'microsoft' ? 'microsoft' : 'gmail'
  const tokens = emailAuthStore.getToken<OAuthTokens>(account.id)
  if (!tokens) {
    throw new Error(`${account.address} is not connected. Reconnect it in Settings -> Email.`)
  }
  if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken
  if (!tokens.refreshToken) {
    throw new Error(
      `${account.address} needs to be reconnected — its session expired and no refresh token is stored.`
    )
  }

  const config = oauthConfigFor(provider, {
    clientId: account.oauthClientId,
    clientSecret: emailAuthStore.getClientSecret(account.id) ?? undefined
  })
  const refreshed = await refreshOAuthTokens(config, tokens.refreshToken)
  emailAuthStore.setToken(account.id, refreshed)
  return refreshed.accessToken
}
