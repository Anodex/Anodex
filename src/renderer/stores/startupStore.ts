import { create } from 'zustand'

export type StartupPhase = 'initializing' | 'ready' | 'error' | 'done'

export interface StartupError {
  title: string
  detail: string
}

interface StartupState {
  /**
   * Lifecycle of the boot overlay. `ready` means hydrate() resolved — the
   * overlay reacts by playing the jump and then marks itself `done`. Never
   * driven by timers.
   */
  phase: StartupPhase
  /** Milestone line shown under the mark while initialising. */
  statusText: string
  /** True when this launch had to auto-configure from hardware (first run). */
  firstLaunch: boolean
  error: StartupError | null
  setStatus: (text: string) => void
  markFirstLaunch: () => void
  /** Re-arm the overlay for a retry after a failed hydrate. */
  beginAttempt: () => void
  setReady: () => void
  setError: (title: string, detail: string) => void
  /** Overlay finished (jump played or calm-dismissed) and unmounted itself. */
  dismiss: () => void
}

/**
 * Startup readiness reported by the real hydrate sequence in
 * `useAnodexBridge`. Once the overlay has dismissed itself the store goes
 * quiet: a re-run of hydrate (React StrictMode re-mounts the bridge effect in
 * dev) must not resurrect the overlay over a working app.
 */
export const useStartupStore = create<StartupState>((set, get) => ({
  phase: 'initializing',
  statusText: 'Starting local core',
  firstLaunch: false,
  error: null,

  setStatus: (statusText) => {
    if (get().phase === 'done') return
    set({ statusText })
  },

  markFirstLaunch: () => set({ firstLaunch: true }),

  beginAttempt: () => {
    if (get().phase === 'done') return
    set({ phase: 'initializing', error: null, statusText: 'Starting local core' })
  },

  setReady: () => {
    if (get().phase === 'done') return
    set({ phase: 'ready', statusText: 'Opening Anodex' })
  },

  setError: (title, detail) => {
    if (get().phase === 'done') return
    set({ phase: 'error', error: { title, detail } })
  },

  dismiss: () => set({ phase: 'done' })
}))
