import { createServer, type Server, type ServerResponse } from 'node:http'
import { shell } from 'electron'

/** How long to wait for the user to complete a browser-based OAuth authorization before giving up. */
export const DEFAULT_OAUTH_TIMEOUT_MS = 120_000

/**
 * Runs a full loopback-redirect OAuth authorization round-trip: starts a
 * one-shot HTTP server on `127.0.0.1` (OS-assigned port), opens the
 * authorization URL (built from the resolved redirect URI) in the system
 * browser, and resolves with the callback's query params once a request with
 * a matching `state` arrives.
 *
 * A callback with an `error` param fails the promise immediately. A callback
 * with a missing/mismatched `state` is shown an error page but does *not*
 * fail the promise — the server keeps listening, so a stray or replayed
 * request can't break a real in-flight authorization. Only a genuine timeout
 * (or an `error` param) rejects. The server always closes itself, on success,
 * failure, or timeout.
 *
 * Originally Gmail-specific (see `EmailService.ts`'s `waitForOAuthCode`);
 * extracted so the MCP OAuth client (`src/main/mcp/oauth.ts`) can reuse the
 * exact same, already-working mechanism instead of a second copy.
 */
export async function runLoopbackAuthorization(options: {
  /** Expected `state` value for the callback request. */
  expectedState: string
  /** Given the resolved `redirect_uri`, returns the full authorization URL to open in the system browser. */
  buildAuthorizationUrl: (redirectUri: string) => string | URL
  timeoutMs?: number
  /**
   * Bind a specific port instead of letting the OS assign one. Needed when
   * the redirect URI must be stable across attempts (e.g. it's embedded in a
   * dynamic client registration's `redirect_uris`) — see the MCP OAuth
   * provider (`src/main/mcp/oauth.ts`), which needs the same redirect URI
   * every time. Gmail's flow (no fixed client-registered redirect URI)
   * doesn't need this and leaves it unset.
   */
  port?: number
}): Promise<{ params: URLSearchParams; redirectUri: string }> {
  const { server, port } = await createLoopbackServer(options.port)
  const redirectUri = `http://127.0.0.1:${port}`

  const paramsPromise = new Promise<URLSearchParams>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for authorization.'))
    }, options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS)

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      const incomingState = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')

      if (error) {
        sendOAuthResponse(res, 'Authorization was cancelled.')
        clearTimeout(timeout)
        server.close()
        reject(new Error(`Authorization failed: ${error}`))
        return
      }
      if (!code || incomingState !== options.expectedState) {
        sendOAuthResponse(res, 'Invalid authorization response.')
        return
      }

      sendOAuthResponse(res, 'Connected. You can return to Anodex.')
      clearTimeout(timeout)
      server.close()
      resolve(url.searchParams)
    })
  })

  await shell.openExternal(options.buildAuthorizationUrl(redirectUri).toString())
  const params = await paramsPromise
  return { params, redirectUri }
}

function createLoopbackServer(port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not start the OAuth callback server.'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

function sendOAuthResponse(res: ServerResponse, message: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<html><body><h1>${escapeHtml(message)}</h1></body></html>`)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
