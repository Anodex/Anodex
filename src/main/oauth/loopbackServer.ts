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
 * `state` is checked before anything else, and a callback that does not carry
 * the expected value is shown an error page but does *not* fail the promise —
 * the server keeps listening, so a stray or replayed request can't break a
 * real in-flight authorization. That has to cover the `error` param too: this
 * port is reachable by anything on the machine for as long as it is open, and
 * the range is small enough to scan, so an unauthenticated `?error=` used to be
 * enough for any local process — or any page open in the user's browser — to
 * cancel an authorization in progress. A genuine provider denial still fails
 * fast, because RFC 6749 §4.1.2.1 requires the authorization server to echo
 * `state` back on the error redirect.
 *
 * Only a matching-state `error`, or a timeout, rejects. The server always
 * closes itself: on success, failure, timeout, or a browser that would not
 * open.
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
  /**
   * Hostname used in the redirect URI. The socket always binds `127.0.0.1`;
   * this only changes the string handed to the authorization server. Microsoft
   * Entra only special-cases `http://localhost` for arbitrary-port desktop
   * redirects, so its flow needs 'localhost' where Google accepts either.
   */
  redirectHost?: '127.0.0.1' | 'localhost'
  /**
   * Abandon the authorization and release the port. Needed by any caller that
   * binds a *fixed* port (see `port`), because there the leftover listener
   * doesn't just idle — it makes the next attempt fail with `EADDRINUSE` until
   * the original times out.
   */
  signal?: AbortSignal
}): Promise<{ params: URLSearchParams; redirectUri: string }> {
  const { server, port } = await createLoopbackServer(options.port)
  const redirectUri = `http://${options.redirectHost ?? '127.0.0.1'}:${port}`

  let stop = (): void => {}
  let cancel = (_reason: Error): void => {}

  const paramsPromise = new Promise<URLSearchParams>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop()
      reject(new Error('Timed out waiting for authorization.'))
    }, options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS)
    stop = () => {
      clearTimeout(timeout)
      server.close()
    }
    cancel = (reason) => {
      stop()
      reject(reason)
    }
    if (options.signal) {
      const onAbort = (): void => cancel(new Error('Authorization was cancelled.'))
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')

      // Before anything is acted on, including `error` — see this function's
      // doc comment for why the failure path needs the same proof of origin
      // the success path does.
      if (url.searchParams.get('state') !== options.expectedState) {
        sendOAuthResponse(res, 'Invalid authorization response.')
        return
      }
      if (error) {
        sendOAuthResponse(res, 'Authorization was cancelled.')
        cancel(new Error(`Authorization failed: ${error}`))
        return
      }
      if (!code) {
        sendOAuthResponse(res, 'Invalid authorization response.')
        return
      }

      sendOAuthResponse(res, 'Connected. You can return to Anodex.')
      stop()
      resolve(url.searchParams)
    })
  })
  // Nothing awaits `paramsPromise` until the end of this function, and the
  // browser step in between can fail. Without a handler attached from the
  // start, that abandoned promise's own timeout rejection surfaced as an
  // unhandled rejection two minutes after the call that caused it. Attaching
  // one here does not stop the `await` below seeing the same rejection.
  paramsPromise.catch(() => {})

  try {
    await shell.openExternal(options.buildAuthorizationUrl(redirectUri).toString())
  } catch (error) {
    // The flow is over; the port must not stay open for the rest of the timeout.
    cancel(error instanceof Error ? error : new Error(String(error)))
    throw error
  }

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
