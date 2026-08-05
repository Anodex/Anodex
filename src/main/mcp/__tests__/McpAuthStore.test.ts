import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MCP credential storage — one blob per server, holding a static bearer token,
 * a dynamic client registration, and the OAuth tokens. Its own doc comment
 * calls it an "exact mirror of `EmailAuthStore`"; these cover the parts where
 * it had stopped being one.
 */

let userDataDir = ''
let encryptionAvailable = true
/** Stands in for a keyring that is present but refuses — locked, or another user's. */
let decryptionFails = false

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (buffer: Buffer) => {
      if (decryptionFails) throw new Error('The keyring is locked.')
      return buffer.toString('utf-8')
    }
  }
}))

const { mcpAuthStore } = await import('../McpAuthStore')

/** Minimal shapes the SDK's own types accept. */
const tokens = (accessToken: string) => ({ access_token: accessToken, token_type: 'Bearer' })
const client = (clientId: string) => ({
  client_id: clientId,
  redirect_uris: ['http://127.0.0.1:53129/callback']
})

function authFile(): string {
  return join(userDataDir, 'mcp-auth.json')
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'anodex-mcp-auth-'))
  encryptionAvailable = true
  decryptionFails = false
  mcpAuthStore.init()
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('McpAuthStore — a credential file that cannot be read', () => {
  it('keeps the unreadable file instead of overwriting it', async () => {
    // There is no second copy of this file. Writing an empty store back over
    // it takes every other server's tokens with it.
    mcpAuthStore.set('server-a', { staticToken: 'token-a' })
    writeFileSync(authFile(), '{"server-a": "truncated', 'utf-8')

    mcpAuthStore.set('server-b', { staticToken: 'token-b' })

    expect(readFileSync(`${authFile()}.corrupt`, 'utf-8')).toContain('server-a')
    await Promise.resolve()
  })

  it('still starts from empty so the app keeps working', () => {
    writeFileSync(authFile(), 'not json at all', 'utf-8')

    expect(mcpAuthStore.get('server-a')).toBeNull()
  })
})

describe('McpAuthStore — a keyring that will not decrypt', () => {
  it('refuses to replace a record it could not read', () => {
    // `get` answers null both for "no record" and "would not decrypt". Merging
    // a patch onto the second silently drops the client registration and the
    // static token alongside it.
    mcpAuthStore.set('server-a', { staticToken: 'keep-me', oauthTokens: tokens('at') })
    decryptionFails = true

    expect(() => mcpAuthStore.update('server-a', { oauthTokens: tokens('new') })).toThrow(
      /could not be read/
    )
  })

  it('leaves the stored record intact after that refusal', () => {
    mcpAuthStore.set('server-a', { staticToken: 'keep-me' })
    decryptionFails = true
    expect(() => mcpAuthStore.update('server-a', { oauthTokens: tokens('x') })).toThrow()

    decryptionFails = false
    expect(mcpAuthStore.get('server-a')?.staticToken).toBe('keep-me')
  })

  it('still allows a first write for a server that has no record yet', () => {
    // The refusal must only apply where something is actually at risk.
    decryptionFails = true

    expect(() => mcpAuthStore.update('brand-new', { staticToken: 'first' })).not.toThrow()
  })
})

describe('McpAuthStore — writing', () => {
  // Passes pre-fix: `set` refuses before it writes anything when encryption is
  // unavailable, so this guards the refusal rather than the atomic write. The
  // temp-file-and-rename itself is not covered — forcing a failure between the
  // two portably is not something a unit test can do honestly.
  it('does not touch the file when it refuses to encrypt', () => {
    mcpAuthStore.set('server-a', { staticToken: 'token-a' })
    const before = readFileSync(authFile(), 'utf-8')

    encryptionAvailable = false
    expect(() => mcpAuthStore.set('server-b', { staticToken: 'token-b' })).toThrow()

    expect(readFileSync(authFile(), 'utf-8')).toBe(before)
  })

  it('refuses to answer before it has been initialised', async () => {
    // A path of '' used to make reads report a server as having no
    // credentials at all, which reads as "never authorized".
    vi.resetModules()
    const fresh = await import('../McpAuthStore')

    expect(() => fresh.mcpAuthStore.get('server-a')).toThrow(/before it was initialized/)
  })
})

describe('McpAuthStore — round trip', () => {
  it('stores and returns a record without leaving it readable on disk', () => {
    mcpAuthStore.set('server-a', { staticToken: 'super-secret', oauthClient: client('c1') })

    expect(mcpAuthStore.get('server-a')?.staticToken).toBe('super-secret')
    expect(readFileSync(authFile(), 'utf-8')).not.toContain('super-secret')
  })

  it('merges a patch into what is already stored', () => {
    mcpAuthStore.set('server-a', { staticToken: 'keep-me' })

    mcpAuthStore.update('server-a', { oauthTokens: tokens('at') })

    const record = mcpAuthStore.get('server-a')
    expect(record?.staticToken).toBe('keep-me')
    expect(record?.oauthTokens?.access_token).toBe('at')
  })

  it('forgets a server completely when cleared', () => {
    mcpAuthStore.set('server-a', { staticToken: 'gone' })

    mcpAuthStore.clear('server-a')

    expect(mcpAuthStore.get('server-a')).toBeNull()
    expect(existsSync(authFile())).toBe(true)
  })
})
