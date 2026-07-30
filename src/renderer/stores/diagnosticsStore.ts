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
  /**
   * Merge already-stamped entries recorded by the main process (background
   * services, crash handlers) into the list, newest first, ignoring ones
   * already present. Called both with the backlog replayed on mount and with
   * single entries as they're broadcast live.
   */
  ingest: (incoming: DiagnosticEntry[]) => void
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
      entry.category === 'integration' ||
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
      // Errors always keep their detail. Verbose governs debug chatter on
      // warnings and info; dropping it from an error deletes the only
      // explanation the user gets — a real symptom of this was "Failed to load
      // model" showing with nothing behind it while the engine's actual
      // "needs more RAM/VRAM, try CPU-only" guidance sat in the discarded field.
      detail: runtimeSettings.verbose || entry.severity === 'error' ? entry.detail : undefined,
      id: createId('diag'),
      timestamp: Date.now()
    }
    set((state) => {
      const next = [diagnostic, ...state.entries]
      if (next.length > runtimeSettings.maxEntries) next.length = runtimeSettings.maxEntries
      return commitEntries(next)
    })
  },

  ingest: (incoming) =>
    set((state) => {
      const known = new Set(state.entries.map((entry) => entry.id))
      const fresh = incoming.filter((entry) => entry.id && !known.has(entry.id))
      if (fresh.length === 0) return { entries: state.entries }

      // Main-process entries keep their detail regardless of the verbose
      // setting: a stack trace is the entire point of surfacing a background
      // failure, and verbose governs the UI's own debug chatter, not failures
      // that already happened. The full text is in the log file either way.
      const next = [...fresh, ...state.entries].sort((a, b) => b.timestamp - a.timestamp)
      if (next.length > runtimeSettings.maxEntries) next.length = runtimeSettings.maxEntries
      return commitEntries(next)
    }),

  remove: (id) => set((state) => commitEntries(state.entries.filter((entry) => entry.id !== id))),

  clear: (category) =>
    set((state) =>
      commitEntries(category ? state.entries.filter((entry) => entry.category !== category) : [])
    ),

  exportText: () => {
    return get()
      .entries.map((e) => {
        const time = new Date(e.timestamp).toISOString()
        const origin = e.scope ? `${e.category}/${e.scope}` : e.category
        const where = e.source === 'main' ? ' [background service]' : ''
        const fix = e.suggestedFix ? `\n  Suggested fix: ${e.suggestedFix}` : ''
        const detail = e.detail ? `\n  Detail: ${e.detail}` : ''
        return `[${time}] ${e.severity.toUpperCase()} (${origin})${where}: ${e.message}${detail}${fix}`
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
