import { describe, expect, it, vi } from 'vitest'
import type { ReminderChannel } from '@shared/scheduledTask.types'
import { deliverReminder, type ReminderSenders } from '../reminderDelivery'

const AT = new Date(2026, 9, 10, 15, 0)

function senders(overrides: Partial<ReminderSenders> = {}) {
  const desktop = vi.fn()
  const phone = vi.fn()
  const email = vi.fn(() => Promise.resolve())
  return {
    desktop,
    phone,
    email,
    all: { desktop, phone, email, phoneConnected: () => true, ...overrides }
  }
}

async function deliver(
  via: ReminderChannel[] | undefined,
  overrides: Partial<ReminderSenders> = {}
) {
  const s = senders(overrides)
  const summary = await deliverReminder('Call Sam', via, s.all, AT)
  return { ...s, summary }
}

describe('deliverReminder', () => {
  it('shows on the desktop and the phone when nothing more was asked for', async () => {
    const { desktop, phone, email, summary } = await deliver(undefined)
    expect(desktop).toHaveBeenCalledWith('Call Sam', 'Reminder')
    expect(phone).toHaveBeenCalledWith('Call Sam', 'Reminder')
    expect(email).not.toHaveBeenCalled()
    expect(summary).toMatch(/^Reminded on your phone and on the desktop at /)
  })

  it('goes only to the phone when that is what was asked', async () => {
    const { desktop, phone } = await deliver(['phone'])
    expect(phone).toHaveBeenCalledOnce()
    expect(desktop).not.toHaveBeenCalled()
  })

  it('falls back to the desktop, and says why, when the phone is not connected', async () => {
    const { desktop, phone, summary } = await deliver(['phone'], { phoneConnected: () => false })
    expect(phone).not.toHaveBeenCalled()
    expect(desktop).toHaveBeenCalledWith('Call Sam', 'Reminder · your phone was not connected')
    expect(summary).toContain('the phone was not connected')
  })

  it('emails the reminder when asked, with the message in the subject', async () => {
    const { email, desktop, summary } = await deliver(['email'])
    expect(email).toHaveBeenCalledWith('Reminder: Call Sam', expect.stringContaining('Call Sam'))
    expect(desktop).not.toHaveBeenCalled()
    expect(summary).toMatch(/^Reminded by email/)
  })

  it('falls back to the desktop when the email cannot be sent', async () => {
    const { desktop, summary } = await deliver(['email'], {
      email: () => Promise.reject(new Error('no email account is linked'))
    })
    expect(desktop).toHaveBeenCalledWith('Call Sam', 'Reminder · the email could not be sent')
    expect(summary).toContain('no email account is linked')
  })
})
