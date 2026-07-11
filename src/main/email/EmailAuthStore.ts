import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EmailProvider } from '@shared/email.types'
import { createLogger } from '../utils/logger'

const log = createLogger('email:auth')

type TokenStore = Partial<Record<EmailProvider, string>>

class EmailAuthStore {
  private filePath = ''

  init(): void {
    this.filePath = join(app.getPath('userData'), 'email-auth.json')
    this.ensureDir(dirname(this.filePath))
  }

  hasToken(provider: EmailProvider): boolean {
    return Boolean(this.read()[provider])
  }

  getToken<TToken>(provider: EmailProvider): TToken | null {
    const encrypted = this.read()[provider]
    if (!encrypted) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) as TToken
    } catch (error) {
      log.warn('Failed to decrypt email token:', error)
      return null
    }
  }

  setToken<TToken>(provider: EmailProvider, token: TToken): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is not available on this system.')
    }
    const next = this.read()
    next[provider] = safeStorage.encryptString(JSON.stringify(token)).toString('base64')
    this.write(next)
  }

  clearToken(provider: EmailProvider): void {
    const next = this.read()
    delete next[provider]
    this.write(next)
  }

  private read(): TokenStore {
    if (!this.filePath || !existsSync(this.filePath)) return {}
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as TokenStore
    } catch (error) {
      log.warn('Failed to read email auth store:', error)
      return {}
    }
  }

  private write(tokens: TokenStore): void {
    this.ensureDir(dirname(this.filePath))
    writeFileSync(this.filePath, JSON.stringify(tokens, null, 2), 'utf-8')
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export const emailAuthStore = new EmailAuthStore()
