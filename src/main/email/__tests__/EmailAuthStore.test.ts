import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * First coverage for the one file in the app whose entire purpose is holding
 * credentials: OAuth tokens, IMAP passwords, and user-supplied client secrets
 * for every linked mailbox. There is no other copy of it — losing it costs the
 * user a re-link of every account — which is what made its read-failure path
 * worth this much attention.
 *
 * `safeStorage` is faked with a reversible marker so what is on disk can be
 * asserted; the real one is DPAPI/Keychain and unavailable in a test process.
 */

let userDataDir = ''
let encryptionAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`E:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf-8')
      if (!text.startsWith('E:')) throw new Error('not encrypted by this keychain')
      return text.slice(2)
    }
  }
}))

type Store = (typeof import('../EmailAuthStore'))['emailAuthStore']

let emailAuthStore: Store

function authFile(): string {
  return join(userDataDir, 'email-auth.json')
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(authFile(), 'utf-8')) as Record<string, unknown>
}

async function freshStore(initialize = true): Promise<Store> {
  vi.resetModules()
  const module = await import('../EmailAuthStore')
  if (initialize) module.emailAuthStore.init()
  return module.emailAuthStore
}

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'anodex-email-auth-'))
  encryptionAvailable = true
  emailAuthStore = await freshStore()
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('EmailAuthStore — round trips', () => {
  it('stores and returns a token, and never writes it in the clear', () => {
    emailAuthStore.setToken('account-1', { accessToken: 'secret-access' })

    expect(emailAuthStore.getToken('account-1')).toEqual({ accessToken: 'secret-access' })
    expect(readFileSync(authFile(), 'utf-8')).not.toContain('secret-access')
  })

  it('keeps the three secrets on one account independent', () => {
    emailAuthStore.setToken('account-1', { accessToken: 'a' })
    emailAuthStore.setPassword('account-1', 'hunter2')
    emailAuthStore.setClientSecret('account-1', 'client-secret')

    // Writing one must not drop the other two — `patch` merges the stored
    // entry, which is what makes a token refresh safe for an IMAP password.
    emailAuthStore.setToken('account-1', { accessToken: 'b' })

    expect(emailAuthStore.getToken('account-1')).toEqual({ accessToken: 'b' })
    expect(emailAuthStore.getPassword('account-1')).toBe('hunter2')
    expect(emailAuthStore.getClientSecret('account-1')).toBe('client-secret')
  })

  it('reports credentials from either a token or a password', () => {
    expect(emailAuthStore.hasCredentials('account-1')).toBe(false)
    emailAuthStore.setPassword('account-1', 'hunter2')
    expect(emailAuthStore.hasCredentials('account-1')).toBe(true)
    // A client secret alone is not a way into a mailbox.
    emailAuthStore.setClientSecret('account-2', 'client-secret')
    expect(emailAuthStore.hasCredentials('account-2')).toBe(false)
  })

  it('normalizes the pre-multi-account format, where the value was the token itself', () => {
    // Stored form is base64 of the encrypted bytes, which the fake keychain
    // marks with `E:`.
    const stored = Buffer.from('E:{"accessToken":"legacy"}', 'utf-8').toString('base64')
    writeFileSync(authFile(), JSON.stringify({ gmail: stored }), 'utf-8')

    expect(emailAuthStore.getToken('gmail')).toEqual({ accessToken: 'legacy' })

    emailAuthStore.setPassword('gmail', 'p')
    // The bare string is rewritten as a full entry, so the legacy shape
    // disappears the first time anything writes to that account.
    const rewritten = readRaw().gmail as Record<string, string>
    expect(Object.keys(rewritten).sort()).toEqual(['password', 'token'])
  })

  it('returns null for a token that will not decrypt, without destroying it', () => {
    writeFileSync(authFile(), JSON.stringify({ 'account-1': { token: 'bm90LWVuY3J5cHRlZA==' } }))

    expect(emailAuthStore.getToken('account-1')).toBeNull()
    // The unreadable ciphertext survives — a keychain that is locked now may
    // open later, and overwriting it would make that unrecoverable.
    expect(readRaw()['account-1']).toEqual({ token: 'bm90LWVuY3J5cHRlZA==' })
  })
})

describe('EmailAuthStore — an unreadable file', () => {
  /**
   * The regression. `read` returned `{}` on a parse failure and the next write
   * persisted that empty store over the original, taking every account with it.
   * The settings, conversation and checkpoint stores all quarantine instead;
   * this is the file where it costs the most.
   */
  it('moves a corrupt file aside instead of overwriting it', async () => {
    writeFileSync(authFile(), JSON.stringify({ 'account-1': { token: 'E:one' } }), 'utf-8')
    const original = readFileSync(authFile(), 'utf-8')
    writeFileSync(authFile(), `${original.slice(0, 20)}`, 'utf-8') // truncated mid-object
    const truncated = readFileSync(authFile(), 'utf-8')

    const store = await freshStore()
    store.setToken('account-2', { accessToken: 'two' })

    expect(readFileSync(`${authFile()}.corrupt`, 'utf-8')).toBe(truncated)
    expect(Object.keys(readRaw())).toEqual(['account-2'])
  })

  it('still starts from empty so the app can run', async () => {
    writeFileSync(authFile(), 'not json at all', 'utf-8')
    const store = await freshStore()

    expect(store.getToken('account-1')).toBeNull()
    expect(store.hasCredentials('account-1')).toBe(false)
  })
})

describe('EmailAuthStore — writing', () => {
  it('leaves no temporary file behind', () => {
    emailAuthStore.setToken('account-1', { accessToken: 'a' })

    expect(readdirSync(userDataDir)).toEqual(['email-auth.json'])
  })

  it.runIf(process.platform !== 'win32')('writes the file owner-only', () => {
    emailAuthStore.setToken('account-1', { accessToken: 'a' })

    expect(statSync(authFile()).mode & 0o777).toBe(0o600)
  })

  it('refuses to write anything when the OS keychain is unavailable', () => {
    encryptionAvailable = false

    expect(() => emailAuthStore.setToken('account-1', { accessToken: 'a' })).toThrow(
      /not available/
    )
    // Nothing half-written: a credential file that exists but holds plaintext
    // would be worse than no file at all.
    expect(readdirSync(userDataDir)).toEqual([])
  })

  /**
   * The write goes to a temporary file and is renamed into place, so a crash
   * part-way through cannot leave truncated JSON — and truncated JSON here is
   * every linked mailbox needing to be reconnected. Fault-injected at
   * `renameSync`, since the interesting half is what survives a failure.
   */
  it('leaves the previous file intact, and no debris, when the rename fails', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    let failNextRename = false
    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actual,
      default: actual,
      renameSync: (from: string, to: string) => {
        if (failNextRename && to.endsWith('email-auth.json')) throw new Error('disk full')
        return actual.renameSync(from, to)
      }
    }))

    try {
      const { emailAuthStore: store } = await import('../EmailAuthStore')
      store.init()
      store.setToken('account-1', { accessToken: 'first' })
      const before = readFileSync(authFile(), 'utf-8')

      failNextRename = true
      expect(() => store.setToken('account-2', { accessToken: 'second' })).toThrow(/disk full/)

      // The account already on disk is untouched, and the half-written copy is
      // gone rather than left beside it.
      expect(readFileSync(authFile(), 'utf-8')).toBe(before)
      expect(readdirSync(userDataDir)).toEqual(['email-auth.json'])
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('refuses to be used before init rather than answering from an empty path', async () => {
    const store = await freshStore(false)

    expect(() => store.getToken('account-1')).toThrow(/before it was initialized/)
    expect(() => store.setToken('account-1', { accessToken: 'a' })).toThrow(
      /before it was initialized/
    )
  })
})

describe('EmailAuthStore — removal', () => {
  it('clears one account and leaves the others', () => {
    emailAuthStore.setToken('account-1', { accessToken: 'a' })
    emailAuthStore.setToken('account-2', { accessToken: 'b' })

    emailAuthStore.clear('account-1')

    expect(emailAuthStore.getToken('account-1')).toBeNull()
    expect(emailAuthStore.getToken('account-2')).toEqual({ accessToken: 'b' })
  })

  it('prunes credentials whose account no longer exists', () => {
    emailAuthStore.setToken('account-1', { accessToken: 'a' })
    emailAuthStore.setToken('account-2', { accessToken: 'b' })

    emailAuthStore.pruneTo(['account-2'])

    expect(Object.keys(readRaw())).toEqual(['account-2'])
  })

  it('does not rewrite the file when nothing is stale', () => {
    emailAuthStore.setToken('account-1', { accessToken: 'a' })
    const before = statSync(authFile()).mtimeMs

    emailAuthStore.pruneTo(['account-1'])

    expect(statSync(authFile()).mtimeMs).toBe(before)
  })
})
