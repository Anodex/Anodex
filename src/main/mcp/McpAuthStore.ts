import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  OAuthClientInformationFull,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { createLogger } from '../utils/logger'

const log = createLogger('mcp:auth')

/** Everything needed to authenticate to one MCP server, keyed by server id. */
export interface McpServerAuthRecord {
  /** Set for a remote server using a pasted bearer token instead of OAuth. */
  staticToken?: string
  /** Environment values for a local stdio server. Keys are exposed in config; values never are. */
  environment?: Record<string, string>
  /** RFC 7591 dynamic client registration result, cached so re-auth doesn't re-register. */
  oauthClient?: OAuthClientInformationFull
  /** Current OAuth token set, once authorized. */
  oauthTokens?: OAuthTokens
}

type RecordStore = Record<string, string>

/**
 * Persists MCP server credentials (static tokens and OAuth client/token
 * records), encrypted with the OS credential store, in Electron's `userData`
 * directory. Exact mirror of `EmailAuthStore` — same file shape, same
 * `safeStorage` encryption, keyed by server id instead of email provider.
 */
class McpAuthStore {
  private filePath = ''

  init(): void {
    this.filePath = join(app.getPath('userData'), 'mcp-auth.json')
    this.ensureDir(dirname(this.filePath))
  }

  has(serverId: string): boolean {
    return Boolean(this.read()[serverId])
  }

  hasStaticToken(serverId: string): boolean {
    return Boolean(this.get(serverId)?.staticToken)
  }

  get(serverId: string): McpServerAuthRecord | null {
    const encrypted = this.read()[serverId]
    if (!encrypted) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      return JSON.parse(
        safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      ) as McpServerAuthRecord
    } catch (error) {
      log.warn('Failed to decrypt MCP auth record:', error)
      return null
    }
  }

  set(serverId: string, record: McpServerAuthRecord): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is not available on this system.')
    }
    const next = this.read()
    next[serverId] = safeStorage.encryptString(JSON.stringify(record)).toString('base64')
    this.write(next)
  }

  /** Merge a partial update into the existing record (or start fresh if none exists). */
  update(serverId: string, patch: Partial<McpServerAuthRecord>): void {
    // `get` answers `null` both for "no record" and for "a record that would
    // not decrypt", and merging onto the second is a wipe: a keyring that is
    // locked or late turns `saveTokens` into "forget this server's client
    // registration and static token too". Unlike `EmailAuthStore`, which keeps
    // each field separately encrypted and can merge without decrypting
    // anything, one record here is a single blob — so the difference has to be
    // checked rather than assumed.
    const existing = this.get(serverId)
    if (!existing && this.read()[serverId]) {
      throw new Error(
        'Stored credentials for this MCP server could not be read, so they were not replaced. ' +
          'Unlock the OS credential store and try again.'
      )
    }
    this.set(serverId, { ...existing, ...patch })
  }

  clear(serverId: string): void {
    const next = this.read()
    delete next[serverId]
    this.write(next)
  }

  private read(): RecordStore {
    this.assertReady()
    if (!existsSync(this.filePath)) return {}
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as RecordStore
    } catch (error) {
      // Same reasoning as `EmailAuthStore.read`, which this file is supposed to
      // mirror: falling back to an empty store is right, but returning it
      // without moving the file aside is destructive — the next `set` or
      // `clear` writes that emptiness back and takes every *other* server's
      // tokens with it. There is no second copy.
      this.quarantine(error)
      return {}
    }
  }

  /** Move an unreadable credential file aside, best effort. */
  private quarantine(error: unknown): void {
    const aside = `${this.filePath}.corrupt`
    try {
      renameSync(this.filePath, aside)
      log.warn(`Could not parse MCP credentials; moved to ${aside}.`, error)
    } catch (renameError) {
      log.error(
        'Could not parse MCP credentials and could not move the file aside — the next save ' +
          'will overwrite it:',
        renameError
      )
    }
  }

  private write(records: RecordStore): void {
    this.assertReady()
    this.ensureDir(dirname(this.filePath))
    // Temp file plus rename, and `mode: 0o600`, for the same reasons spelled
    // out in `EmailAuthStore.write`: a crash part-way through a direct write
    // leaves truncated JSON, and truncated JSON here is every MCP server
    // needing to be re-authorized.
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    try {
      writeFileSync(temporaryPath, JSON.stringify(records, null, 2), {
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
   * Refuse to answer before `init()` has run. Reads used to return `{}` from a
   * path of `''` — a server with stored credentials reporting itself as having
   * none — and writes failed on an unrelated `ENOENT`.
   */
  private assertReady(): void {
    if (!this.filePath) {
      throw new Error('The MCP credential store was used before it was initialized.')
    }
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export const mcpAuthStore = new McpAuthStore()
