import { DEFAULT_REMINDER_CHANNELS, type ReminderChannel } from '@shared/scheduledTask.types'

/** How each channel is reached. The service passes the real ones; tests pass their own. */
export interface ReminderSenders {
  desktop: (title: string, body: string) => void
  /** Whether a paired phone is connected right now, and so can be told. */
  phoneConnected: () => boolean
  phone: (title: string, body: string) => void
  /** Rejects when no account is linked or the send fails. */
  email: (subject: string, body: string) => Promise<void>
}

/**
 * Show a reminder where it was asked for, and say where it went.
 *
 * Two fallbacks, both onto the desktop, so a reminder is never silently lost:
 * a phone that is not connected at that moment (the phone is reached directly,
 * with no push service to wake it), and an email that fails to send. The
 * returned line is what the Scheduler records for the run.
 */
export async function deliverReminder(
  message: string,
  channels: readonly ReminderChannel[] | undefined,
  senders: ReminderSenders,
  at: Date
): Promise<string> {
  const wanted = new Set(channels?.length ? channels : DEFAULT_REMINDER_CHANNELS)
  const reached: string[] = []
  const notes: string[] = []
  let desktopNote: string | null = null

  if (wanted.has('phone')) {
    if (senders.phoneConnected()) {
      senders.phone(message, 'Reminder')
      reached.push('on your phone')
    } else {
      notes.push('the phone was not connected')
      desktopNote = 'Reminder · your phone was not connected'
    }
  }
  if (wanted.has('email')) {
    try {
      await senders.email(`Reminder: ${message}`, `${message}\n\nSet as a reminder in Anodex.`)
      reached.push('by email')
    } catch (error) {
      notes.push(
        `the email could not be sent (${error instanceof Error ? error.message : String(error)})`
      )
      desktopNote = 'Reminder · the email could not be sent'
    }
  }
  if (wanted.has('desktop') || desktopNote) {
    senders.desktop(message, wanted.has('desktop') ? 'Reminder' : (desktopNote ?? 'Reminder'))
    reached.push('on the desktop')
  }

  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const where = reached.length ? reached.join(' and ') : 'nowhere'
  return `Reminded ${where} at ${time}${notes.length ? `; ${notes.join(', ')}` : ''}`
}
