import { create } from 'zustand'
import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import { anodex } from '../lib/anodex'
import { createId } from '../lib/id'
import { playChime } from '../lib/sound'
import { notifyDesktop } from '../lib/notifications'
import { logDiagnostic } from './diagnosticsStore'

export type AppView = 'chat' | 'settings'
export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  message?: string
}

interface UiState {
  view: AppView
  toasts: Toast[]
  readConversationAt: Record<string, number>
  /** A write/command approval awaiting the user's decision, if any. */
  pendingConfirmation: ToolConfirmRequest | null
  setView: (view: AppView) => void
  markConversationRead: (conversationId: string, updatedAt: number) => void
  markConversationUnread: (conversationId: string, updatedAt: number) => void
  notify: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  setPendingConfirmation: (request: ToolConfirmRequest | null) => void
  resolveConfirmation: (response: ToolConfirmResponse) => void
}

const READ_MARKERS_KEY = 'anodex:readConversationAt'

function loadReadMarkers(): Record<string, number> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(READ_MARKERS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, number>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveReadMarkers(markers: Record<string, number>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(READ_MARKERS_KEY, JSON.stringify(markers))
  } catch {
    /* noop */
  }
}

/** Global, ephemeral UI state: the active view, toasts, and tool approvals. */
export const useUiStore = create<UiState>((set, get) => ({
  view: 'chat',
  toasts: [],
  readConversationAt: loadReadMarkers(),
  pendingConfirmation: null,

  setView: (view) => set({ view }),

  markConversationRead: (conversationId, updatedAt) => {
    set((state) => {
      const readConversationAt = { ...state.readConversationAt, [conversationId]: updatedAt }
      saveReadMarkers(readConversationAt)
      return { readConversationAt }
    })
  },

  markConversationUnread: (conversationId, updatedAt) => {
    set((state) => {
      const readConversationAt = {
        ...state.readConversationAt,
        [conversationId]: Math.max(1, updatedAt - 1)
      }
      saveReadMarkers(readConversationAt)
      return { readConversationAt }
    })
  },

  setPendingConfirmation: (request) => set({ pendingConfirmation: request }),

  resolveConfirmation: (response) => {
    const pending = get().pendingConfirmation
    if (!pending) return
    void anodex.tools.respondConfirmation(pending.id, response)
    set({ pendingConfirmation: null })
  },

  notify: (toast) => {
    const id = createId('toast')
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    const ttl = toast.kind === 'error' ? 7000 : 4000
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, ttl)

    playChime(toast.kind === 'error' ? 'error' : 'success')
    if (toast.kind === 'success') notifyDesktop(toast.title, toast.message ?? '')
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
}))

/** Convenience helper for the common error-toast case. Also logs to diagnostics. */
export function notifyError(title: string, message?: string): void {
  useUiStore.getState().notify({ kind: 'error', title, message })
  logDiagnostic('error', 'runtime', title, message)
}
