import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OAuthClientConfig } from '../oauth'

/**
 * The mail token exchange — the call behind every Gmail and Graph request, and
 * the one place a bad response turns into a mailbox that has to be re-linked.
 * It had no tests; `fetch` is mocked the way `webTools.test.ts` does it.
 */

vi.mock('../../oauth/loopbackServer', () => ({ runLoopbackAuthorization: vi.fn() }))

const { refreshOAuthTokens } = await import('../oauth')

const config: OAuthClientConfig = {
  authUrl: 'https://provider.example/authorize',
  tokenUrl: 'https://provider.example/token',
  scopes: ['mail.read', 'mail.send'],
  clientId: 'client-123'
}

/** The request options `fetch` was called with, per call. */
let requests: RequestInit[] = []

function respondWith(body: unknown, init: { ok?: boolean; status?: number } = {}): void {
  globalThis.fetch = vi.fn().mockImplementation((_url: string, options: RequestInit) => {
    requests.push(options)
    return Promise.resolve({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
    })
  })
}

beforeEach(() => {
  requests = []
})

describe('the mail token exchange', () => {
  it('gives the request a deadline of its own', async () => {
    // Node's fetch has none. `accessTokenFor` coalesces concurrent refreshes
    // onto one call, so a token endpoint that accepts and never answers would
    // hold every mail request in flight behind this one.
    respondWith({ access_token: 'at', expires_in: 3600 })

    await refreshOAuthTokens(config, 'rt')

    expect(requests[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses a 200 that carries no access token', async () => {
    // Some providers answer an error this way. Storing the missing field sends
    // `Bearer undefined` on every request until the user re-links the account.
    respondWith({ error: 'invalid_grant' })

    await expect(refreshOAuthTokens(config, 'rt')).rejects.toThrow(
      /did not include an access token/
    )
  })

  it('keeps the existing refresh token when the provider omits a new one', async () => {
    // Omitting it means "keep using the one you have"; dropping it strands the
    // account at the next expiry with no way back but a full re-authorization.
    respondWith({ access_token: 'at', expires_in: 3600 })

    const tokens = await refreshOAuthTokens(config, 'the-original-refresh-token')

    expect(tokens.refreshToken).toBe('the-original-refresh-token')
  })

  it('takes a rotated refresh token when the provider sends one', async () => {
    respondWith({ access_token: 'at', refresh_token: 'rotated', expires_in: 3600 })

    const tokens = await refreshOAuthTokens(config, 'the-original-refresh-token')

    expect(tokens.refreshToken).toBe('rotated')
  })

  it('backs the expiry off so a token is never used at the moment it lapses', async () => {
    respondWith({ access_token: 'at', expires_in: 3600 })

    const tokens = await refreshOAuthTokens(config, 'rt')

    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000 - 30_000)
  })

  it('does not reproduce a whole error page in the message it raises', async () => {
    // A provider answering with HTML would otherwise put the entire page into
    // an Error that is logged and shown to the user.
    respondWith(`<html><body>${'x'.repeat(5_000)}</body></html>`, { ok: false, status: 500 })

    await expect(refreshOAuthTokens(config, 'rt')).rejects.toThrow(/OAuth token request failed/)
    await expect(refreshOAuthTokens(config, 'rt')).rejects.toSatisfy(
      (error: Error) => error.message.length < 700
    )
  })
})
