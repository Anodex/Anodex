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
  /** A write/command approval awaiting the user's decision, if any. */
  pendingConfirmation: ToolConfirmRequest | null
  /** Tool names approved with "always allow" for the rest of this app session. Not persisted. */
  rememberedTools: Set<string>
  setView: (view: AppView) => void
  notify: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  setPendingConfirmation: (request: ToolConfirmRequest | null) => void
  resolveConfirmation: (response: ToolConfirmResponse) => void
  rememberTool: (toolName: string) => void
}

/** Global, ephemeral UI state: the active view, toasts, and tool approvals. */
export const useUiStore = create<UiState>((set, get) => ({
  view: 'chat',
  toasts: [],
  pendingConfirmation: null,
  rememberedTools: new Set(),

  setView: (view) => set({ view }),

  setPendingConfirmation: (request) => set({ pendingConfirmation: request }),

  resolveConfirmation: (response) => {
    const pending = get().pendingConfirmation
    if (!pending) return
    void anodex.tools.respondConfirmation(pending.id, response)
    if (response.approved && response.remember) get().rememberTool(pending.toolName)
    set({ pendingConfirmation: null })
  },

  rememberTool: (toolName) =>
    set((state) => ({ rememberedTools: new Set(state.rememberedTools).add(toolName) })),

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
