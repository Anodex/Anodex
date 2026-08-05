import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount } from '@shared/email.types'
import type { OAuthTokens } from '../../oauth'

/**
 * First coverage for the module every Gmail and Graph request goes through to
 * get a bearer token. Round four ranked it first because a defect here is not a
 * wrong answer — it is a session dropped, or a refresh token spent twice and
 * invalidated, which costs the user a re-link of their mailbox.
 *
 * `../../oauth` and the token store are mocked: what matters is how many times
 * this module asks for a refresh, with what, and what it stores afterwards.
 */

const refreshOAuthTokens = vi.fn<(config: unknown, token: string) => Promise<OAuthTokens>>()
const getToken = vi.fn<(id: string) => OAuthTokens | null>()
const setToken = vi.fn<(id: string, token: OAuthTokens) => void>()
const getClientSecret = vi.fn<(id: string) => string | null>()

vi.mock('../../oauth', () => ({
  authorizeWithPkce: vi.fn(),
  refreshOAuthTokens: (config: unknown, token: string) => refreshOAuthTokens(config, token)
}))

vi.mock('../../EmailAuthStore', () => ({
  emailAuthStore: {
    getToken: (id: string) => getToken(id),
    setToken: (id: string, token: OAuthTokens) => setToken(id, token),
    getClientSecret: (id: string) => getClientSecret(id)
  }
}))

const { accessTokenFor, oauthConfigFor } = await import('../oauthClients')

function account(overrides: Partial<EmailAccount> = {}): EmailAccount {
  return {
    id: 'account-1',
    provider: 'microsoft',
    address: 'user@outlook.com',
    displayName: 'user',
    authKind: 'oauth',
    syncMode: 'metadata',
    createdAt: 0,
    ...overrides
  }
}

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'access-old',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 3_600_000,
    scope: 'scope',
    tokenType: 'Bearer',
    ...overrides
  }
}

/** A token already inside the refresh margin. */
function expiredTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return tokens({ expiresAt: Date.now() + 5_000, ...overrides })
}

beforeEach(() => {
  refreshOAuthTokens.mockReset()
  getToken.mockReset()
  setToken.mockReset()
  getClientSecret.mockReset()
  getClientSecret.mockReturnValue(null)
})

describe('accessTokenFor', () => {
  it('uses the cached token while it still has time left', async () => {
    getToken.mockReturnValue(tokens())

    expect(await accessTokenFor(account())).toBe('access-old')
    expect(refreshOAuthTokens).not.toHaveBeenCalled()
  })

  it('refreshes inside the margin and persists what came back', async () => {
    getToken.mockReturnValue(expiredTokens())
    refreshOAuthTokens.mockResolvedValue(tokens({ accessToken: 'access-new' }))

    expect(await accessTokenFor(account())).toBe('access-new')
    expect(refreshOAuthTokens).toHaveBeenCalledTimes(1)
    expect(setToken).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({
        accessToken: 'access-new'
      })
    )
  })

  /**
   * The regression this module was reviewed for. Both adapters open a thread by
   * fetching its messages through `Promise.all`, so an expired token used to
   * start one refresh per message — each redeeming the same refresh token.
   * Entra invalidates a refresh token the moment it is redeemed, so the first
   * through would kill the one the rest were still using.
   */
  it('collapses concurrent callers into a single refresh', async () => {
    getToken.mockReturnValue(expiredTokens())
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    refreshOAuthTokens.mockImplementation(async () => {
      await gate
      return tokens({ accessToken: 'access-new' })
    })

    const waiting = Array.from({ length: 12 }, () => accessTokenFor(account()))
    await Promise.resolve()
    release()
    const results = await Promise.all(waiting)

    expect(refreshOAuthTokens).toHaveBeenCalledTimes(1)
    expect(results).toEqual(Array.from({ length: 12 }, () => 'access-new'))
    // One refresh means one write, so nothing can store a token another caller
    // has already rotated away.
    expect(setToken).toHaveBeenCalledTimes(1)
  })

  it('refreshes again on the next expiry rather than caching the promise forever', async () => {
    getToken.mockReturnValue(expiredTokens())
    refreshOAuthTokens.mockResolvedValue(tokens({ accessToken: 'access-new' }))

    await accessTokenFor(account())
    await accessTokenFor(account())

    expect(refreshOAuthTokens).toHaveBeenCalledTimes(2)
  })

  it('lets a failed refresh be retried instead of remembering it as broken', async () => {
    getToken.mockReturnValue(expiredTokens())
    refreshOAuthTokens.mockRejectedValueOnce(new Error('network down'))
    refreshOAuthTokens.mockResolvedValueOnce(tokens({ accessToken: 'access-new' }))

    await expect(accessTokenFor(account())).rejects.toThrow(/network down/)
    expect(await accessTokenFor(account())).toBe('access-new')
  })

  it('does not persist anything when the refresh fails', async () => {
    getToken.mockReturnValue(expiredTokens())
    refreshOAuthTokens.mockRejectedValue(new Error('network down'))

    await expect(accessTokenFor(account())).rejects.toThrow()
    expect(setToken).not.toHaveBeenCalled()
  })

  it('tells the user to reconnect only when the grant itself was rejected', async () => {
    getToken.mockReturnValue(expiredTokens())
    refreshOAuthTokens.mockRejectedValue(
      new Error('OAuth token request failed (400): {"error":"invalid_grant"}')
    )

    await expect(accessTokenFor(account())).rejects.toThrow(
      /user@outlook\.com needs to be reconnected/
    )
  })

  it('does not send someone to re-link their mailbox over a transient failure', async () => {
    getToken.mockReturnValue(expiredTokens())
    refreshOAuthTokens.mockRejectedValue(new Error('fetch failed'))

    const message = await accessTokenFor(account()).then(
      () => 'resolved',
      (error: Error) => error.message
    )

    expect(message).toMatch(/Could not renew the session for user@outlook\.com/)
    // The recovery for a transient failure is to try again, not to re-link a
    // mailbox that was never broken.
    expect(message).not.toMatch(/reconnect/i)
  })

  it('refuses an account that was never connected', async () => {
    getToken.mockReturnValue(null)

    await expect(accessTokenFor(account())).rejects.toThrow(/is not connected/)
  })

  it('refuses an expired session with no refresh token', async () => {
    getToken.mockReturnValue(expiredTokens({ refreshToken: undefined }))

    await expect(accessTokenFor(account())).rejects.toThrow(/no refresh token is stored/)
  })

  // `EmailProvider` includes `imap`, and the previous ternary filed anything
  // that was not Microsoft under Google — which would have posted an IMAP
  // account's credentials to Google's token endpoint.
  it('refuses an IMAP account rather than treating it as Google', async () => {
    getToken.mockReturnValue(expiredTokens())
    refreshOAuthTokens.mockResolvedValue(tokens())

    await expect(accessTokenFor(account({ provider: 'imap' }))).rejects.toThrow(
      /IMAP account and does not use OAuth/
    )
    expect(refreshOAuthTokens).not.toHaveBeenCalled()
  })

  it('refreshes each account independently', async () => {
    getToken.mockReturnValue(expiredTokens())
    refreshOAuthTokens.mockResolvedValue(tokens({ accessToken: 'access-new' }))

    await Promise.all([
      accessTokenFor(account({ id: 'account-1' })),
      accessTokenFor(account({ id: 'account-2' }))
    ])

    expect(refreshOAuthTokens).toHaveBeenCalledTimes(2)
  })
})

describe('oauthConfigFor', () => {
  it('asks Google for a refresh token explicitly', () => {
    const config = oauthConfigFor('gmail', { clientId: 'id' })

    // Without both of these Google returns access-only tokens and the account
    // dies an hour later with no way back but a full re-authorization.
    expect(config.extraAuthParams).toEqual({ access_type: 'offline', prompt: 'consent' })
    expect(config.scopes).toContain('https://www.googleapis.com/auth/gmail.modify')
    // Permanent deletion needs `mail.google.com`, which is deliberately absent.
    expect(config.scopes).not.toContain('https://mail.google.com/')
  })

  it('keeps Microsoft on a loopback host Entra will accept, and asks for offline access', () => {
    const config = oauthConfigFor('microsoft', { clientId: 'id' })

    expect(config.redirectHost).toBe('localhost')
    expect(config.scopes).toContain('offline_access')
  })

  it('prefers a per-account client id over the built-in one', () => {
    expect(oauthConfigFor('gmail', { clientId: '  custom-id  ' }).clientId).toBe('custom-id')
  })
})
