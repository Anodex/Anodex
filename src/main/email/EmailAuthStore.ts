import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
    this.assertReady()
    if (!existsSync(this.filePath)) return {}
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as CredentialStore
    } catch (error) {
      // Falling back to an empty store is right — the app has to start — but
      // returning it without moving the file aside was destructive: the next
      // `setToken`, `clear` or link writes that empty store back over the
      // original, taking every other account's tokens and passwords with it.
      // There is no other copy of this file, so the cost is re-linking every
      // mailbox. Same quarantine the settings, conversation and checkpoint
      // stores already do, on the one file where it matters most.
      this.quarantine(error)
      return {}
    }
  }

  /** Move an unreadable credential file aside, best effort. */
  private quarantine(error: unknown): void {
    const aside = `${this.filePath}.corrupt`
    try {
      renameSync(this.filePath, aside)
      log.warn(`Could not parse email credentials; moved to ${aside}.`, error)
    } catch (renameError) {
      log.error(
        'Could not parse email credentials and could not move the file aside — the next ' +
          'save will overwrite it:',
        renameError
      )
    }
  }

  private write(credentials: CredentialStore): void {
    this.assertReady()
    this.ensureDir(dirname(this.filePath))
    // Written to a temporary file and renamed into place, as the Critical
    // Thinking stores do. A crash or a full disk part-way through a direct
    // write leaves truncated JSON, and truncated JSON here is every linked
    // mailbox needing to be reconnected — rename is atomic, so the file is
    // either the old contents or the new ones.
    //
    // `mode: 0o600` because this is the one file in the app whose whole purpose
    // is holding credentials. The contents are `safeStorage`-encrypted and
    // `encrypt` refuses to write anything when that is unavailable, so this is
    // defence in depth rather than the thing keeping them safe. Ignored on
    // Windows, which is what the DPAPI encryption is for.
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    try {
      writeFileSync(temporaryPath, JSON.stringify(credentials, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
      })
      renameSync(temporaryPath, this.filePath)
    } catch (error) {
      try {
        if (existsSync(temporaryPath)) rmSync(temporaryPath)
      } catch {
        /* Best effort: a stray temp file is preferable to masking the error. */
      }
      throw error
    }
  }

  /**
   * Refuse to work before `init()` has run rather than answering from a path of
   * `''`. Reads previously returned `{}` — a linked account reporting itself as
   * having no credentials — and writes failed on an unrelated `ENOENT` from
   * `writeFileSync('')`.
   */
  private assertReady(): void {
    if (!this.filePath) {
      throw new Error('The email credential store was used before it was initialized.')
    }
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export const emailAuthStore = new EmailAuthStore()
