import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailConnectPasswordRequest } from '@shared/email.types'

const state = vi.hoisted(() => ({
  account: null as EmailAccount | null,
  password: 'old-password',
  rejected: false,
  verifyPassword: vi.fn(),
  disconnect: vi.fn(),
  clearAuthenticationFailure: vi.fn()
}))

vi.mock('../EmailAccountStore', () => ({
  emailAccountStore: {
    list: () => (state.account ? [state.account] : []),
    primary: () => state.account,
    add: (account: EmailAccount) => {
      state.account = account
      return account
    }
  }
}))
vi.mock('../EmailAuthStore', () => ({
  emailAuthStore: {
    hasCredentials: () => Boolean(state.password),
    setPassword: (_id: string, password: string) => {
      state.password = password
    }
  }
}))
vi.mock('../providers/GmailAdapter', () => ({ GmailAdapter: class {} }))
vi.mock('../providers/MicrosoftAdapter', () => ({ MicrosoftAdapter: class {} }))
vi.mock('../providers/ImapSmtpAdapter', () => ({
  ImapSmtpAdapter: class {
    needsReconnect() {
      return state.rejected
    }
    verifyPassword = state.verifyPassword
    disconnect = state.disconnect
    clearAuthenticationFailure = state.clearAuthenticationFailure
  }
}))
vi.mock('../../diagnostics/DiagnosticsReporter', () => ({
  diagnosticsReporter: { resolved: vi.fn() }
}))

const { emailService } = await import('../EmailService')

const request: EmailConnectPasswordRequest = {
  address: 'mail@example.com',
  password: 'new-password',
  imap: { host: 'imap.example.com', port: 993, security: 'tls', username: 'mail@example.com' },
  smtp: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'mail@example.com' }
}

beforeEach(() => {
  state.account = {
    id: 'existing-id',
    provider: 'imap',
    address: request.address,
    displayName: request.address,
    authKind: 'password',
    syncMode: 'metadata',
    imap: request.imap,
    smtp: request.smtp,
    createdAt: 1
  }
  state.password = 'old-password'
  state.rejected = true
  state.verifyPassword.mockReset()
  state.disconnect.mockReset()
  state.clearAuthenticationFailure.mockReset()
})

describe('IMAP reconnection', () => {
  it('retains the linked account and old password when replacement verification fails', async () => {
    state.verifyPassword.mockRejectedValue(new Error('invalid credentials'))

    await expect(emailService.connectPassword(request)).rejects.toThrow('invalid credentials')

    expect(state.account?.id).toBe('existing-id')
    expect(state.password).toBe('old-password')
    expect(state.disconnect).not.toHaveBeenCalled()
    expect(emailService.getStatus().accounts[0].connected).toBe(false)
    expect(emailService.getStatus().accounts[0].reason).toContain('rejected')
  })

  it('verifies a fresh connection before replacing the saved password', async () => {
    state.verifyPassword.mockResolvedValue({
      address: request.address,
      displayName: request.address
    })

    await emailService.connectPassword(request)

    expect(state.verifyPassword).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'existing-id' }),
      'new-password'
    )
    expect(state.password).toBe('new-password')
    expect(state.disconnect).toHaveBeenCalledWith('existing-id')
    expect(state.clearAuthenticationFailure).toHaveBeenCalledWith('existing-id')
  })
})
