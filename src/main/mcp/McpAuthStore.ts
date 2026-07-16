import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    this.set(serverId, { ...this.get(serverId), ...patch })
  }

  clear(serverId: string): void {
    const next = this.read()
    delete next[serverId]
    this.write(next)
  }

  private read(): RecordStore {
    if (!this.filePath || !existsSync(this.filePath)) return {}
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as RecordStore
    } catch (error) {
      log.warn('Failed to read MCP auth store:', error)
      return {}
    }
  }

  private write(records: RecordStore): void {
    this.ensureDir(dirname(this.filePath))
    writeFileSync(this.filePath, JSON.stringify(records, null, 2), 'utf-8')
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export const mcpAuthStore = new McpAuthStore()
