import { notifyRemoteClients } from '../notify'
import { showToastWindow } from '../toastWindow'
import { activeRemoteClients } from '../clients/clientRegistry'
import { emailService } from '../email/EmailService'
import { settingsStore } from '../settings/SettingsStore'
import type { ReminderSenders } from './reminderDelivery'

/**
 * How a reminder reaches each place. The phone is told directly, with
 * `'finished'` as its ordinary notification kind (a new kind would change the
 * protocol the phone app is built against for no difference on screen); email
 * goes from the person's primary linked account to its own address, and to no
 * one else.
 */
export const reminderSenders: ReminderSenders = {
  desktop: (title, body) => showToastWindow({ title, body }),
  phoneConnected: () => activeRemoteClients().length > 0,
  phone: (title, body) =>
    notifyRemoteClients({ kind: 'finished', title, body, atEpochMs: Date.now() }),
  email: async (subject, body) => {
    const { accounts, primaryAccountId } = settingsStore.get().email
    const account = accounts.find((a) => a.id === primaryAccountId) ?? accounts[0]
    if (!account) throw new Error('no email account is linked')
    await emailService.send({ accountId: account.id, to: [account.address], subject, body })
  }
}
