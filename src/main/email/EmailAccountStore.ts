import { randomUUID } from 'node:crypto'
import type { EmailAccount } from '@shared/email.types'
import { settingsStore } from '../settings/SettingsStore'
import { emailAuthStore } from './EmailAuthStore'
import { createLogger } from '../utils/logger'

const log = createLogger('email:accounts')

/** Fields a caller supplies when linking; id and createdAt are assigned here. */
export type NewEmailAccount = Omit<EmailAccount, 'id' | 'createdAt'> & { id?: string }

/**
 * Owns the account list in `AppSettings.email`. Everything that mutates
 * accounts goes through here rather than through settings patches directly:
 * `deepMerge` replaces arrays wholesale, so a read-modify-write done at two
 * call sites would silently drop one of the two accounts.
 *
 * Credentials are not this class's concern beyond lifecycle — it tells
 * {@link emailAuthStore} to drop secrets when an account goes away, so unlinking
 * can't leave a usable token on disk.
 */
class EmailAccountStore {
  list(): EmailAccount[] {
    return settingsStore.get().email.accounts
  }

  get(accountId: string): EmailAccount | undefined {
    return this.list().find((account) => account.id === accountId)
  }

  primary(): EmailAccount | null {
    const { accounts, primaryAccountId } = settingsStore.get().email
    if (accounts.length === 0) return null
    return accounts.find((account) => account.id === primaryAccountId) ?? accounts[0]
  }

  primaryId(): string | null {
    return this.primary()?.id ?? null
  }

  /**
   * Resolves the account a request targets. An omitted id means "the primary
   * account", which is what keeps single-account setups from having to name an
   * account on every tool call.
   */
  resolve(accountId?: string): EmailAccount {
    const trimmed = accountId?.trim()
    if (!trimmed) {
      const primary = this.primary()
      if (!primary) {
        throw new Error('No email account is linked. Add one in Settings -> Email.')
      }
      return primary
    }

    const exact = this.get(trimmed)
    if (exact) return exact

    // Models tend to pass the address rather than the opaque id — accept it,
    // since it is unambiguous and the alternative is a dead-end tool error.
    const byAddress = this.list().find(
      (account) => account.address.toLowerCase() === trimmed.toLowerCase()
    )
    if (byAddress) return byAddress

    const known = this.list()
      .map((account) => `${account.address} (${account.id})`)
      .join(', ')
    throw new Error(
      known
        ? `Unknown email account "${trimmed}". Linked accounts: ${known}.`
        : `Unknown email account "${trimmed}". No accounts are linked.`
    )
  }

  add(account: NewEmailAccount): EmailAccount {
    const { accounts, primaryAccountId } = settingsStore.get().email
    const address = account.address.trim().toLowerCase()
    const existing = accounts.find(
      (candidate) =>
        candidate.address.toLowerCase() === address && candidate.provider === account.provider
    )

    // Re-linking an account that is already present must update it in place —
    // otherwise reconnecting after a token expiry silently accumulates
    // duplicate entries pointing at the same mailbox.
    const id = account.id ?? existing?.id ?? randomUUID()
    const next: EmailAccount = {
      ...account,
      id,
      address: account.address.trim(),
      displayName: account.displayName.trim() || account.address.trim(),
      createdAt: existing?.createdAt ?? Date.now()
    }

    const remaining = accounts.filter((candidate) => candidate.id !== id)
    settingsStore.update({
      email: {
        accounts: [...remaining, next],
        primaryAccountId: primaryAccountId ?? id
      }
    })
    log.info(`Linked email account ${next.address} (${next.provider}).`)
    return next
  }

  update(accountId: string, patch: Partial<Omit<EmailAccount, 'id' | 'createdAt'>>): EmailAccount {
    const accounts = this.list()
    const current = accounts.find((account) => account.id === accountId)
    if (!current) throw new Error(`Unknown email account: ${accountId}`)
    const next: EmailAccount = { ...current, ...patch, id: current.id }
    settingsStore.update({
      email: { accounts: accounts.map((account) => (account.id === accountId ? next : account)) }
    })
    return next
  }

  remove(accountId: string): void {
    const { accounts, primaryAccountId } = settingsStore.get().email
    const remaining = accounts.filter((account) => account.id !== accountId)
    if (remaining.length === accounts.length) return

    settingsStore.update({
      email: {
        accounts: remaining,
        primaryAccountId:
          primaryAccountId === accountId ? (remaining[0]?.id ?? null) : primaryAccountId
      }
    })
    emailAuthStore.clear(accountId)
    log.info(`Unlinked email account ${accountId}.`)
  }

  setPrimary(accountId: string): void {
    if (!this.get(accountId)) throw new Error(`Unknown email account: ${accountId}`)
    settingsStore.update({ email: { primaryAccountId: accountId } })
  }

  /** Drops orphaned credentials at startup, after settings have loaded. */
  pruneCredentials(): void {
    emailAuthStore.pruneTo(this.list().map((account) => account.id))
  }
}

export const emailAccountStore = new EmailAccountStore()
