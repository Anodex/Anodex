import { create } from 'zustand'
import type { DiagnosticEntry } from '@shared/settings.types'
import { createId } from '../lib/id'

interface DiagnosticsState {
  entries: DiagnosticEntry[]
  /** Add a new diagnostic entry, trimming the oldest when over limit. */
  add: (entry: Omit<DiagnosticEntry, 'id' | 'timestamp'>) => void
  /** Remove a single entry by id. */
  remove: (id: string) => void
  /** Clear all entries or filter by category. */
  clear: (category?: DiagnosticEntry['category']) => void
  /** Export entries as a readable text log. */
  exportText: () => string
}

const MAX_ENTRIES = 250

/** In-memory collection of runtime diagnostic events for the Diagnostics page. */
export const useDiagnosticsStore = create<DiagnosticsState>((set, get) => ({
  entries: [],

  add: (entry) => {
    const diagnostic: DiagnosticEntry = {
      ...entry,
      id: createId('diag'),
      timestamp: Date.now()
    }
    set((state) => {
      const next = [diagnostic, ...state.entries]
      if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES
      return { entries: next }
    })
  },

  remove: (id) => set((state) => ({ entries: state.entries.filter((e) => e.id !== id) })),

  clear: (category) =>
    set((state) => ({
      entries: category ? state.entries.filter((e) => e.category !== category) : []
    })),

  exportText: () => {
    return get()
      .entries.map((e) => {
        const time = new Date(e.timestamp).toISOString()
        const fix = e.suggestedFix ? `\n  Suggested fix: ${e.suggestedFix}` : ''
        const detail = e.detail ? `\n  Detail: ${e.detail}` : ''
        return `[${time}] ${e.severity.toUpperCase()} (${e.category}): ${e.message}${detail}${fix}`
      })
      .join('\n\n')
  }
}))

/** Convenience helper to log a runtime error from anywhere in the renderer. */
export function logDiagnostic(
  severity: DiagnosticEntry['severity'],
  category: DiagnosticEntry['category'],
  message: string,
  detail?: string,
  suggestedFix?: string
): void {
  useDiagnosticsStore.getState().add({ severity, category, message, detail, suggestedFix })
}
