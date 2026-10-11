import type { BackgroundProcessInfo } from '@shared/process.types'
import {
  deliverReminder,
  type NoticeWording,
  type ReminderSenders
} from '../scheduler/reminderDelivery'
import type { DoneNotice } from './replyNotices'

const DONE_WORDING: NoticeWording = {
  label: 'Done',
  footer: 'You asked Anodex to tell you when this was done.'
}

interface ProcessSource {
  get(id: string): BackgroundProcessInfo | undefined
  onChange(listener: (info: BackgroundProcessInfo) => void): () => void
}

/**
 * "Tell me when it's done": a notice that goes out when something finishes.
 *
 * It is delivered exactly as a reminder is, so it reaches the desktop, the
 * phone or email, with the same fallback to the desktop when the phone is away
 * or the email fails.
 */
export class DoneNotices {
  constructor(
    private readonly senders: () => ReminderSenders,
    private readonly processes: () => ProcessSource
  ) {}

  async deliver(notice: DoneNotice, state: string): Promise<void> {
    await deliverReminder(
      `${notice.message}: ${state}`,
      notice.via,
      this.senders(),
      new Date(),
      DONE_WORDING
    )
  }

  /**
   * Watch a background process: `ready` once it shows a local address (or has
   * ended), `exits` once it has ended. Says `'now'` when that has already
   * happened, so the caller can tell the person instead of waiting for nothing.
   */
  watchProcess(
    processId: string,
    when: 'ready' | 'exits',
    notice: DoneNotice
  ): 'now' | 'watching' | 'unknown' {
    const source = this.processes()
    const current = source.get(processId)
    if (!current) return 'unknown'
    const reached = (info: BackgroundProcessInfo): string | null => {
      if (info.status === 'exited') return `finished (exit code ${info.exitCode ?? 'unknown'})`
      if (info.status !== 'running') return info.status
      return when === 'ready' && info.url ? `ready at ${info.url}` : null
    }
    const already = reached(current)
    if (already) {
      void this.deliver(notice, already)
      return 'now'
    }
    const stop = source.onChange((info) => {
      if (info.id !== processId) return
      const state = reached(info)
      if (!state) return
      stop()
      void this.deliver(notice, state)
    })
    return 'watching'
  }
}
