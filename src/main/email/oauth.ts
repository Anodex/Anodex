import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { runLoopbackAuthorization } from '../oauth/loopbackServer'

const AUTH_TIMEOUT_MS = 120_000

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch ms, already backed off 30s from the provider's stated expiry. */
  expiresAt: number
  scope: string
  tokenType: string
}

export interface OAuthClientConfig {
  authUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: string
  /**
   * Only sent when a user brings their own client that requires one. Native
   * apps are public clients under RFC 8252, so the built-in clients use PKCE
   * alone and never carry a secret.
   */
  clientSecret?: string
  /** Provider-specific authorization params (Google's `access_type`, etc.). */
  extraAuthParams?: Record<string, string>
  redirectHost?: '127.0.0.1' | 'localhost'
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
}

/**
 * Runs an authorization-code flow with PKCE (RFC 7636) over the loopback
 * redirect. PKCE is what makes a bundled client id safe to ship: the
 * authorization code is useless without the verifier, which never leaves this
 * process, so a malicious local listener that races the redirect still can't
 * redeem the code.
 */
export async function authorizeWithPkce(config: OAuthClientConfig): Promise<OAuthTokens> {
  if (!config.clientId.trim()) {
    throw new Error('No OAuth client ID is configured for this provider.')
  }

  const state = randomUUID()
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())

  const { params, redirectUri } = await runLoopbackAuthorization({
    expectedState: state,
    timeoutMs: AUTH_TIMEOUT_MS,
    redirectHost: config.redirectHost,
    buildAuthorizationUrl: (uri) => {
      const authParams = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: uri,
        response_type: 'code',
        scope: config.scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        ...config.extraAuthParams
      })
      return `${config.authUrl}?${authParams.toString()}`
    }
  })

  const code = params.get('code')
  if (!code) throw new Error('The authorization response did not include a code.')

  return exchange(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier
  })
}

export async function refreshOAuthTokens(
  config: OAuthClientConfig,
  refreshToken: string
): Promise<OAuthTokens> {
  const tokens = await exchange(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  })
  // Providers may omit the refresh token on renewal, meaning "keep using the
  // one you have" — dropping it here would strand the account at the next
  // expiry with no way back except a full re-authorization.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
}

async function exchange(
  config: OAuthClientConfig,
  fields: Record<string, string>
): Promise<OAuthTokens> {
  const params = new URLSearchParams({ client_id: config.clientId, ...fields })
  if (config.clientSecret?.trim()) params.set('client_secret', config.clientSecret.trim())

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  if (!response.ok) {
    throw new Error(`OAuth token request failed (${response.status}): ${await response.text()}`)
  }

  const payload = (await response.json()) as TokenResponse
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + Math.max(0, (payload.expires_in ?? 3600) - 30) * 1000,
    scope: payload.scope ?? config.scopes.join(' '),
    tokenType: payload.token_type ?? 'Bearer'
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
