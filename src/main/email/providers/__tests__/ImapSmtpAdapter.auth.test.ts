import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount } from '@shared/email.types'

const state = vi.hoisted(() => ({
  rejectLogin: false,
  connections: 0,
  closed: 0,
  passwords: [] as string[]
}))

vi.mock('imapflow', () => ({
  ImapFlow: class {
    usable = true
    private listeners = new Map<string, Array<() => void>>()

    constructor(config: { auth: { pass: string } }) {
      state.passwords.push(config.auth.pass)
    }
    on(event: string, listener: () => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    }
    connect(): Promise<void> {
      state.connections += 1
      if (state.rejectLogin) {
        return Promise.reject(
          Object.assign(new Error('Invalid credentials'), {
            authenticationFailed: true,
            serverResponseCode: 'AUTHENTICATIONFAILED'
          })
        )
      }
      return Promise.resolve()
    }
    status(): Promise<{ unseen: number }> {
      return Promise.resolve({ unseen: 3 })
    }
    getMailboxLock(): Promise<{ release: () => void }> {
      return Promise.resolve({ release: () => {} })
    }
    close(): void {
      if (!this.usable) return
      this.usable = false
      state.closed += 1
      for (const listener of this.listeners.get('close') ?? []) listener()
    }
    logout(): Promise<void> {
      this.close()
      return Promise.resolve()
    }
  }
}))
vi.mock('../../EmailAuthStore', () => ({
  emailAuthStore: { getPassword: () => 'stored-password' }
}))
vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const { ImapSmtpAdapter } = await import('../ImapSmtpAdapter')

const account: EmailAccount = {
  id: 'account-1',
  provider: 'imap',
  address: 'mail@example.com',
  displayName: 'Mail',
  authKind: 'password',
  syncMode: 'metadata',
  imap: { host: 'imap.example.com', port: 993, security: 'tls', username: 'mail@example.com' },
  smtp: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'mail@example.com' },
  createdAt: 1
}

let adapter: InstanceType<typeof ImapSmtpAdapter>

beforeEach(() => {
  adapter = new ImapSmtpAdapter()
  state.rejectLogin = false
  state.connections = 0
  state.closed = 0
  state.passwords = []
})

describe('IMAP authentication failure', () => {
  it('marks a rejected password for reconnection and closes the failed socket', async () => {
    state.rejectLogin = true

    await expect(adapter.getUnreadThreadCount(account)).rejects.toThrow('Invalid credentials')

    expect(adapter.needsReconnect(account.id)).toBe(true)
    expect(state.closed).toBe(1)
  })

  it('clears a prior rejection after a successful connection', async () => {
    state.rejectLogin = true
    await expect(adapter.getUnreadThreadCount(account)).rejects.toThrow()
    state.rejectLogin = false

    await expect(adapter.getUnreadThreadCount(account)).resolves.toBe(3)

    expect(adapter.needsReconnect(account.id)).toBe(false)
    expect(state.connections).toBe(2)
  })

  it('checks a replacement password on a separate socket', async () => {
    await adapter.getUnreadThreadCount(account)

    await adapter.verifyPassword(account, 'replacement-password')

    expect(state.connections).toBe(2)
    expect(state.passwords).toEqual(['stored-password', 'replacement-password'])
    expect(state.closed).toBe(1)
    await expect(adapter.getUnreadThreadCount(account)).resolves.toBe(3)
    expect(state.connections).toBe(2)
  })
})
