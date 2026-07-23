import { create } from 'zustand'
import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import { anodex } from '../lib/anodex'
import { createId } from '../lib/id'
import { playChime } from '../lib/sound'
import { notifyDesktop } from '../lib/notifications'
import { logDiagnostic } from './diagnosticsStore'
import { appendPendingConfirmation, removePendingConfirmation } from './pendingConfirmations'

export type AppView = 'chat' | 'settings' | 'scheduler' | 'agent' | 'critical-thinking' | 'email'
export type ToastKind = 'info' | 'success' | 'error' | 'pending'
export type SettingsSection =
  | 'profile'
  | 'appearance'
  | 'projects'
  | 'tools-skills'
  | 'archive'
  | 'memory'
  | 'email'
  | 'github'
  | 'mcp'
  | 'ai-models'
  | 'diagnostics'
  | 'about'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  message?: string
}

interface UiState {
  view: AppView
  /** Which settings page is showing. Reset to 'profile' each time settings is opened via `openSettings()`, unless a section is given. */
  settingsSection: SettingsSection
  toasts: Toast[]
  readConversationAt: Record<string, number>
  /**
   * Write/command approvals awaiting the user's decision. A queue, not a
   * single slot — node-llama-cpp (and the cloud providers) can genuinely
   * invoke multiple guarded tool calls concurrently within one turn when a
   * model emits several calls at once, so more than one can be pending at
   * the same time.
   */
  pendingConfirmations: ToolConfirmRequest[]
  setView: (view: AppView) => void
  /** Switch to the settings view, optionally jumping straight to a specific section (defaults to 'profile'). */
  openSettings: (section?: SettingsSection) => void
  setSettingsSection: (section: SettingsSection) => void
  markConversationRead: (conversationId: string, updatedAt: number) => void
  markConversationUnread: (conversationId: string, updatedAt: number) => void
  notify: (toast: Omit<Toast, 'id'>) => void
  /**
   * Shows a toast that stays put — no auto-dismiss, no chime — until
   * `resolveToast` flips it to a final kind. For actions worth surfacing
   * even if the user navigates away mid-flight (a scheduled task run).
   * Returns the toast's id.
   */
  notifyPending: (title: string, message?: string) => string
  /** Replaces a pending toast's content and kind, then starts its normal
   *  auto-dismiss/chime lifecycle. No-op if the toast was already dismissed. */
  resolveToast: (id: string, patch: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  addPendingConfirmation: (request: ToolConfirmRequest) => void
  resolveConfirmation: (id: string, response: ToolConfirmResponse) => void
  /**
   * Drop a pending confirmation the main process already settled on its own
   * (generation aborted while the prompt was open) — unlike
   * `resolveConfirmation`, this does NOT call back to main: main is the one
   * that told us about it, so answering it again would just be a no-op
   * there, and if this were routed through `resolveConfirmation` a user who
   * clicks the now-stale card afterward would silently do nothing instead of
   * the card simply not being there.
   */
  dismissCancelledConfirmation: (id: string) => void
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
  settingsSection: 'profile',
  toasts: [],
  readConversationAt: loadReadMarkers(),
  pendingConfirmations: [],

  setView: (view) => set({ view }),

  openSettings: (section) => set({ view: 'settings', settingsSection: section ?? 'profile' }),

  setSettingsSection: (section) => set({ settingsSection: section }),

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

  addPendingConfirmation: (request) =>
    set((state) => ({
      pendingConfirmations: appendPendingConfirmation(state.pendingConfirmations, request)
    })),

  resolveConfirmation: (id, response) => {
    if (!get().pendingConfirmations.some((p) => p.id === id)) return
    void anodex.tools.respondConfirmation(id, response)
    set((state) => ({
      pendingConfirmations: removePendingConfirmation(state.pendingConfirmations, id)
    }))
  },

  dismissCancelledConfirmation: (id) => {
    if (!get().pendingConfirmations.some((p) => p.id === id)) return
    set((state) => ({
      pendingConfirmations: removePendingConfirmation(state.pendingConfirmations, id)
    }))
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

  notifyPending: (title, message) => {
    const id = createId('toast')
    set((state) => ({ toasts: [...state.toasts, { id, kind: 'pending', title, message }] }))
    return id
  },

  resolveToast: (id, patch) => {
    if (!get().toasts.some((t) => t.id === id)) return
    set((state) => ({ toasts: state.toasts.map((t) => (t.id === id ? { id, ...patch } : t)) }))
    const ttl = patch.kind === 'error' ? 7000 : 4000
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, ttl)
    playChime(patch.kind === 'error' ? 'error' : 'success')
    if (patch.kind === 'success') notifyDesktop(patch.title, patch.message ?? '')
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
}))

/** Convenience helper for the common error-toast case. Also logs to diagnostics. */
export function notifyError(title: string, message?: string): void {
  useUiStore.getState().notify({ kind: 'error', title, message })
  logDiagnostic('error', 'runtime', title, message)
}
