import { create } from 'zustand'
import type { DiagnosticEntry, DiagnosticSettings } from '@shared/settings.types'
import { createId } from '../lib/id'

const STORAGE_KEY = 'anodex:diagnostics'
const DEFAULT_MAX_ENTRIES = 250

let runtimeSettings: DiagnosticSettings = {
  maxEntries: DEFAULT_MAX_ENTRIES,
  clearOnRestart: true,
  verbose: false
}

type NewDiagnosticEntry = Omit<DiagnosticEntry, 'id' | 'timestamp'>

interface DiagnosticsState {
  entries: DiagnosticEntry[]
  /** Add a new diagnostic entry, trimming the oldest when over limit. */
  add: (entry: NewDiagnosticEntry) => void
  /** Remove a single entry by id. */
  remove: (id: string) => void
  /** Clear all entries or filter by category. */
  clear: (category?: DiagnosticEntry['category']) => void
  /** Export entries as a readable text log. */
  exportText: () => string
}

function loadEntries(): DiagnosticEntry[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isDiagnosticEntry)
  } catch {
    return []
  }
}

function saveEntries(entries: DiagnosticEntry[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    }
  } catch {
    /* Local persistence is best-effort; diagnostics must never break the app. */
  }
}

function isDiagnosticEntry(value: unknown): value is DiagnosticEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<DiagnosticEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.timestamp === 'number' &&
    (entry.severity === 'error' || entry.severity === 'warning' || entry.severity === 'info') &&
    (entry.category === 'model' ||
      entry.category === 'provider' ||
      entry.category === 'file' ||
      entry.category === 'permission' ||
      entry.category === 'runtime' ||
      entry.category === 'general') &&
    typeof entry.message === 'string'
  )
}

function commitEntries(entries: DiagnosticEntry[]): { entries: DiagnosticEntry[] } {
  saveEntries(entries)
  return { entries }
}

/** Locally persisted collection of runtime events for the Diagnostics page. */
export const useDiagnosticsStore = create<DiagnosticsState>((set, get) => ({
  entries: loadEntries(),

  add: (entry) => {
    const diagnostic: DiagnosticEntry = {
      ...entry,
      detail: runtimeSettings.verbose ? entry.detail : undefined,
      id: createId('diag'),
      timestamp: Date.now()
    }
    set((state) => {
      const next = [diagnostic, ...state.entries]
      if (next.length > runtimeSettings.maxEntries) next.length = runtimeSettings.maxEntries
      return commitEntries(next)
    })
  },

  remove: (id) => set((state) => commitEntries(state.entries.filter((entry) => entry.id !== id))),

  clear: (category) =>
    set((state) =>
      commitEntries(category ? state.entries.filter((entry) => entry.category !== category) : [])
    ),

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

/** Apply persisted Diagnostics settings to the live log. */
export function configureDiagnostics(settings: DiagnosticSettings, onStartup = false): void {
  runtimeSettings = {
    ...settings,
    maxEntries: Math.max(1, Math.floor(settings.maxEntries))
  }

  useDiagnosticsStore.setState((state) => {
    const retained =
      onStartup && runtimeSettings.clearOnRestart
        ? state.entries.filter((entry) => entry.severity !== 'info')
        : state.entries
    return commitEntries(retained.slice(0, runtimeSettings.maxEntries))
  })
}

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
