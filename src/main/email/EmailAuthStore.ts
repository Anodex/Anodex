import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../utils/logger'

const log = createLogger('email:auth')

/**
 * Every secret belonging to one linked account. Each field is independently
 * `safeStorage`-encrypted and base64-encoded; nothing here is ever readable
 * from `email-auth.json` alone.
 */
interface StoredCredentials {
  /** Serialized OAuth token bundle (access + refresh + expiry). */
  token?: string
  /** IMAP/SMTP password or app password. */
  password?: string
  /** Client secret for a user-supplied OAuth client, when their client demands one. */
  clientSecret?: string
}

/**
 * Keyed by account id. A `string` value is the pre-multi-account format, where
 * the key was the provider name and the value was the encrypted OAuth token on
 * its own — normalized on read, rewritten on the next save.
 */
type CredentialStore = Record<string, StoredCredentials | string>

/**
 * Holds email credentials outside `settings.json`, encrypted with the OS
 * credential store. Account descriptors (addresses, hostnames, ports) stay in
 * settings as readable JSON; only this file holds anything that could be used
 * to reach a mailbox.
 */
class EmailAuthStore {
  private filePath = ''

  init(): void {
    this.filePath = join(app.getPath('userData'), 'email-auth.json')
    this.ensureDir(dirname(this.filePath))
  }

  /** True when the account has any credential at all — a token or a password. */
  hasCredentials(accountId: string): boolean {
    const entry = this.entry(accountId)
    return Boolean(entry.token || entry.password)
  }

  getToken<TToken>(accountId: string): TToken | null {
    const decrypted = this.decrypt(this.entry(accountId).token)
    if (!decrypted) return null
    try {
      return JSON.parse(decrypted) as TToken
    } catch (error) {
      log.warn('Failed to parse a stored email token:', error)
      return null
    }
  }

  setToken<TToken>(accountId: string, token: TToken): void {
    this.patch(accountId, { token: this.encrypt(JSON.stringify(token)) })
  }

  getPassword(accountId: string): string | null {
    return this.decrypt(this.entry(accountId).password)
  }

  setPassword(accountId: string, password: string): void {
    this.patch(accountId, { password: this.encrypt(password) })
  }

  getClientSecret(accountId: string): string | null {
    return this.decrypt(this.entry(accountId).clientSecret)
  }

  setClientSecret(accountId: string, clientSecret: string): void {
    this.patch(accountId, { clientSecret: this.encrypt(clientSecret) })
  }

  /** Removes every secret for one account. Called when an account is unlinked. */
  clear(accountId: string): void {
    const next = this.read()
    delete next[accountId]
    this.write(next)
  }

  /**
   * Drops credentials whose account no longer exists in settings, so unlinking
   * (or a settings file restored from elsewhere) can't leave live tokens behind
   * on disk.
   */
  pruneTo(accountIds: readonly string[]): void {
    const keep = new Set(accountIds)
    const current = this.read()
    const stale = Object.keys(current).filter((id) => !keep.has(id))
    if (stale.length === 0) return
    for (const id of stale) delete current[id]
    this.write(current)
    log.info(`Pruned credentials for ${stale.length} unlinked email account(s).`)
  }

  private entry(accountId: string): StoredCredentials {
    const value = this.read()[accountId]
    if (!value) return {}
    return typeof value === 'string' ? { token: value } : value
  }

  private patch(accountId: string, fields: Partial<StoredCredentials>): void {
    const next = this.read()
    // Normalize a legacy string entry in passing, so the old format disappears
    // the first time anything writes to that account.
    const existing = this.entry(accountId)
    next[accountId] = { ...existing, ...fields }
    this.write(next)
  }

  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is not available on this system.')
    }
    return safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(value: string | undefined): string | null {
    if (!value) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch (error) {
      log.warn('Failed to decrypt an email credential:', error)
      return null
    }
  }

  private read(): CredentialStore {
    if (!this.filePath || !existsSync(this.filePath)) return {}
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as CredentialStore
    } catch (error) {
      log.warn('Failed to read email auth store:', error)
      return {}
    }
  }

  private write(credentials: CredentialStore): void {
    this.ensureDir(dirname(this.filePath))
    writeFileSync(this.filePath, JSON.stringify(credentials, null, 2), 'utf-8')
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export const emailAuthStore = new EmailAuthStore()
