import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The loopback redirect both OAuth flows depend on — mail (`email/oauth.ts`)
 * and third-party MCP servers (`mcp/oauth.ts`) — and it had no tests at all.
 *
 * A real server is started on 127.0.0.1 and driven with real requests, because
 * what matters here is precisely what it does with a request that arrives from
 * somewhere other than the authorization server. Anything on the machine can
 * reach that port while it is open, and the port range is small enough to scan.
 */

const openExternal = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>())

vi.mock('electron', () => ({ shell: { openExternal } }))

const { runLoopbackAuthorization } = await import('../loopbackServer')

/** Start an authorization and hand back the callback URL its server is listening on. */
function startAuthorization(expectedState = 'the-real-state'): {
  result: Promise<{ params: URLSearchParams; redirectUri: string }>
  redirectUri: Promise<string>
} {
  let resolveUri: (uri: string) => void = () => {}
  const redirectUri = new Promise<string>((resolve) => {
    resolveUri = resolve
  })
  const result = runLoopbackAuthorization({
    expectedState,
    timeoutMs: 5_000,
    buildAuthorizationUrl: (uri) => {
      resolveUri(uri)
      return `https://provider.example/authorize?redirect_uri=${encodeURIComponent(uri)}`
    }
  })
  return { result, redirectUri }
}

beforeEach(() => {
  openExternal.mockReset()
  openExternal.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the OAuth loopback callback', () => {
  it('completes on a callback carrying the code and the matching state', async () => {
    const { result, redirectUri } = startAuthorization()
    const uri = await redirectUri

    await fetch(`${uri}/?code=the-code&state=the-real-state`)

    const { params } = await result
    expect(params.get('code')).toBe('the-code')
  })

  it('ignores a callback whose state does not match, and keeps waiting', async () => {
    // Documented behaviour: a stray or replayed request must not be able to
    // break an authorization the user is part-way through.
    const { result, redirectUri } = startAuthorization()
    const uri = await redirectUri

    await fetch(`${uri}/?code=someone-elses-code&state=wrong`)
    await fetch(`${uri}/?code=the-code&state=the-real-state`)

    const { params } = await result
    expect(params.get('code')).toBe('the-code')
  })

  it('is not cancelled by an error callback that does not carry the state', async () => {
    // The same guarantee, for the failure path. Any local process can reach
    // this port while it is open, so an `?error=` it did not have to
    // authenticate for must not be able to abort the real flow.
    const { result, redirectUri } = startAuthorization()
    const uri = await redirectUri

    await fetch(`${uri}/?error=access_denied`)
    await fetch(`${uri}/?code=the-code&state=the-real-state`)

    const { params } = await result
    expect(params.get('code')).toBe('the-code')
  })

  it('still fails on a genuine provider error, which echoes the state back', async () => {
    // RFC 6749 §4.1.2.1 requires the authorization server to include `state`
    // in the error redirect when the request carried one, so a real denial is
    // still distinguishable from a stray request.
    const { result, redirectUri } = startAuthorization()
    const uri = await redirectUri
    // Asserted before the request that causes it: the rejection lands the
    // instant the server handles the callback, and attaching the expectation
    // afterwards leaves it momentarily unhandled.
    const rejection = expect(result).rejects.toThrow(/access_denied/)

    await fetch(`${uri}/?error=access_denied&state=the-real-state`)

    await rejection
  })
})

describe('the OAuth loopback server lifetime', () => {
  it('does not leave a rejection unhandled when the browser cannot be opened', async () => {
    // `shell.openExternal` rejects in a sandboxed or headless environment. The
    // authorization promise is abandoned at that point, so its own timeout
    // rejection has nothing attached to it and surfaces as an unhandled
    // rejection minutes later — long after the call that caused it.
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    openExternal.mockRejectedValue(new Error('no browser available'))

    try {
      await expect(
        runLoopbackAuthorization({
          expectedState: 'state',
          timeoutMs: 20,
          buildAuthorizationUrl: () => 'https://provider.example/authorize'
        })
      ).rejects.toThrow(/no browser available/)

      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('stops listening once the browser could not be opened', async () => {
    openExternal.mockRejectedValue(new Error('no browser available'))
    let uri = ''

    await expect(
      runLoopbackAuthorization({
        expectedState: 'state',
        timeoutMs: 5_000,
        buildAuthorizationUrl: (resolved) => {
          uri = resolved
          return 'https://provider.example/authorize'
        }
      })
    ).rejects.toThrow()

    // The port must not stay open for the full timeout after a failure that
    // already ended the flow.
    await expect(fetch(`${uri}/?code=x`)).rejects.toThrow()
  })
})

describe('the OAuth loopback on a fixed port', () => {
  /**
   * The MCP flow registers its redirect URI with the server, so its port
   * cannot vary between attempts — which makes a listener left over from an
   * abandoned attempt an outright blocker rather than an idle socket.
   */
  const FIXED_PORT = 53187

  it('releases the port when the authorization is aborted', async () => {
    const abort = new AbortController()
    const first = runLoopbackAuthorization({
      expectedState: 'state',
      port: FIXED_PORT,
      timeoutMs: 60_000,
      signal: abort.signal,
      buildAuthorizationUrl: () => 'https://provider.example/authorize'
    })
    const firstSettled = expect(first).rejects.toThrow(/cancelled/)

    abort.abort()
    await firstSettled

    // Without the release, this second attempt fails with EADDRINUSE for the
    // rest of the first one's window — which is exactly when a user retries.
    const abortSecond = new AbortController()
    const second = runLoopbackAuthorization({
      expectedState: 'state-2',
      port: FIXED_PORT,
      timeoutMs: 60_000,
      signal: abortSecond.signal,
      buildAuthorizationUrl: (uri) => `https://provider.example/authorize?r=${uri}`
    })
    const secondSettled = expect(second).rejects.toThrow(/cancelled/)
    abortSecond.abort()
    await secondSettled
  })

  it('is already cancelled if the signal arrived aborted', async () => {
    await expect(
      runLoopbackAuthorization({
        expectedState: 'state',
        timeoutMs: 60_000,
        signal: AbortSignal.abort(),
        buildAuthorizationUrl: () => 'https://provider.example/authorize'
      })
    ).rejects.toThrow(/cancelled/)
  })
})
