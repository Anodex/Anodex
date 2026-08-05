import { randomUUID } from 'node:crypto'
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { runLoopbackAuthorization } from '../oauth/loopbackServer'
import { mcpAuthStore } from './McpAuthStore'

/**
 * Fixed local redirect port for MCP OAuth. Unlike Gmail's flow (a single
 * pre-registered Google Cloud client, no dynamic registration), MCP servers
 * are registered on the fly via RFC 7591 — the `redirect_uris` we register
 * must stay the same across attempts, so (unlike Gmail's OS-assigned port
 * per attempt) this one is fixed.
 */
const MCP_OAUTH_REDIRECT_PORT = 53129
const MCP_OAUTH_REDIRECT_URI = `http://127.0.0.1:${MCP_OAUTH_REDIRECT_PORT}/callback`
const MCP_OAUTH_TIMEOUT_MS = 180_000

/**
 * Implements the MCP SDK's `OAuthClientProvider` for one remote server,
 * backed by `McpAuthStore`. `StreamableHTTPClientTransport` (constructed
 * with `authProvider: this`) calls into this automatically on connect: loads
 * a cached token, refreshes it if expired, and — if neither works — opens
 * the authorization URL via `redirectToAuthorization` and throws
 * `UnauthorizedError`.
 *
 * `McpManager` is responsible for catching that error, awaiting
 * `waitForPendingCode()`, calling `transport.finishAuth(code)`, and retrying
 * the connection — see `McpManager.connectServer`.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private codeVerifierValue: string | undefined
  private pendingCode: Promise<string> | undefined
  private pendingAbort: AbortController | undefined
  private stateValue: string | undefined

  constructor(private readonly serverId: string) {}

  /** Called by the SDK's `auth()` orchestrator while building the authorization URL. */
  state(): string {
    this.stateValue = randomUUID()
    return this.stateValue
  }

  get redirectUrl(): string {
    return MCP_OAUTH_REDIRECT_URI
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [MCP_OAUTH_REDIRECT_URI],
      client_name: 'Anodex',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public client (desktop app, no confidential secret storage) using PKCE.
      token_endpoint_auth_method: 'none'
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return mcpAuthStore.get(this.serverId)?.oauthClient
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    mcpAuthStore.update(this.serverId, { oauthClient: info as OAuthClientInformationFull })
  }

  tokens(): OAuthTokens | undefined {
    return mcpAuthStore.get(this.serverId)?.oauthTokens
  }

  saveTokens(tokens: OAuthTokens): void {
    mcpAuthStore.update(this.serverId, { oauthTokens: tokens })
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error('No PKCE code verifier for this authorization attempt.')
    }
    return this.codeVerifierValue
  }

  /**
   * Starts the fixed-port loopback listener *before* opening the browser
   * (avoids a race where the user completes authorization before anything is
   * listening), then opens the authorization URL. `waitForPendingCode()`
   * resolves once the redirect lands.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    // The URL's own `state` first: that is the value actually sent, and so the
    // one the authorization server will echo back. `this.stateValue` is only a
    // fallback for a caller that built the URL without asking for one.
    const expectedState =
      authorizationUrl.searchParams.get('state') ?? this.stateValue ?? randomUUID()
    // This flow binds a fixed port, so an earlier attempt still listening is
    // not merely idle — it makes this one fail with `EADDRINUSE`. Retrying is
    // exactly what a user does after a connect that timed out while its
    // three-minute authorization window was still open.
    this.pendingAbort?.abort()
    const abort = new AbortController()
    this.pendingAbort = abort
    const pending = runLoopbackAuthorization({
      expectedState,
      port: MCP_OAUTH_REDIRECT_PORT,
      timeoutMs: MCP_OAUTH_TIMEOUT_MS,
      signal: abort.signal,
      buildAuthorizationUrl: () => authorizationUrl
    }).then(({ params }) => {
      const code = params.get('code')
      if (!code) throw new Error('MCP authorization response was missing a code.')
      return code
    })
    // Nothing may ever await this. `McpManager` only calls
    // `waitForPendingCode` when the connect attempt failed with
    // `UnauthorizedError`, and its own 20-second connect timeout fires long
    // before this three-minute one — so a slow server abandons this promise,
    // and without a handler its rejection surfaced minutes later with nothing
    // left to connect it to.
    pending.catch(() => {})
    this.pendingCode = pending
  }

  /** Awaits the code captured by the in-flight `redirectToAuthorization()` call. */
  async waitForPendingCode(): Promise<string> {
    if (!this.pendingCode) {
      throw new Error('No MCP authorization redirect is in progress for this server.')
    }
    // Cleared before awaiting, not after. Leaving a rejected promise in place
    // made the next attempt fail instantly with the previous attempt's stale
    // error instead of starting a fresh authorization.
    const pending = this.pendingCode
    this.pendingCode = undefined
    return await pending
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      mcpAuthStore.clear(this.serverId)
      return
    }
    if (scope === 'tokens') mcpAuthStore.update(this.serverId, { oauthTokens: undefined })
    if (scope === 'client') mcpAuthStore.update(this.serverId, { oauthClient: undefined })
    // 'verifier'/'discovery' carry no durable state here — nothing to clear.
  }
}
