import { create } from 'zustand'
import type { EmailConnectionStatus, EmailThreadSummary } from '@shared/email.types'
import { anodex } from '../lib/anodex'

interface EmailState {
  status: EmailConnectionStatus | null
  threads: EmailThreadSummary[]
  unreadCount: number
  loaded: boolean
  load: () => Promise<void>
}

let loadRevision = 0

/** Shared mailbox summary used by both Email and its navigation counter. */
export const useEmailStore = create<EmailState>((set) => ({
  status: null,
  threads: [],
  unreadCount: 0,
  loaded: false,

  load: async () => {
    const revision = ++loadRevision
    try {
      const statusResult = await anodex.email.getStatus()
      if (revision !== loadRevision) return
      if (!statusResult.ok) {
        set({ status: null, threads: [], unreadCount: 0, loaded: true })
        return
      }

      const status = statusResult.value
      if (!status.connected) {
        set({ status, threads: [], unreadCount: 0, loaded: true })
        return
      }

      const [threadsResult, unreadCountResult] = await Promise.all([
        anodex.email.listThreads({ limit: 10 }),
        anodex.email.getUnreadThreadCount()
      ])
      if (revision !== loadRevision) return

      set({
        status,
        threads: threadsResult.ok ? threadsResult.value : [],
        unreadCount: unreadCountResult.ok ? unreadCountResult.value : 0,
        loaded: true
      })
    } catch {
      if (revision === loadRevision) {
        set({ status: null, threads: [], unreadCount: 0, loaded: true })
      }
    }
  }
}))
