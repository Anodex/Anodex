import { create } from 'zustand'

/** Narrower than this, even the minimum sidebar width starts crowding out the
 *  chat — matches AppShell's own layout math, kept here too since the
 *  title-bar toggle button needs to know whether "expand" means reopening
 *  the docked column or just popping a temporary overlay. */
export const SIDEBAR_COLLAPSE_BREAKPOINT = 760

const MANUAL_KEY = 'anodex:sidebarManuallyCollapsed'

function loadManuallyCollapsed(): boolean {
  try {
    return localStorage.getItem(MANUAL_KEY) === '1'
  } catch {
    return false
  }
}

function saveManuallyCollapsed(value: boolean): void {
  try {
    localStorage.setItem(MANUAL_KEY, value ? '1' : '0')
  } catch {
    /* noop */
  }
}

interface SidebarCollapseState {
  /** User's own collapse/expand choice, independent of window width. */
  manuallyCollapsed: boolean
  /** Forced collapse because the window is too narrow for a docked sidebar —
   *  kept in sync by AppShell's resize handling, the one place that already
   *  tracks window width for the sidebar/dock layout math. */
  autoCollapsed: boolean
  /** Temporary full-sidebar overlay shown over a narrow window. */
  overlayOpen: boolean
  setAutoCollapsed: (value: boolean) => void
  setOverlayOpen: (value: boolean) => void
  /** Collapses to the icon rail and persists that as the user's preference. */
  collapse: () => void
  /** Docks the sidebar back open, or — on a narrow window where there's no
   *  room to dock it — opens it as a temporary overlay instead. */
  expand: () => void
  /** Title-bar button: collapse if currently shown, expand if collapsed. */
  toggle: () => void
}

export const useSidebarCollapse = create<SidebarCollapseState>((set, get) => ({
  manuallyCollapsed: loadManuallyCollapsed(),
  autoCollapsed: typeof window !== 'undefined' && window.innerWidth < SIDEBAR_COLLAPSE_BREAKPOINT,
  overlayOpen: false,

  setAutoCollapsed: (autoCollapsed) => {
    set({ autoCollapsed })
    if (!autoCollapsed) set({ overlayOpen: false })
  },

  setOverlayOpen: (overlayOpen) => set({ overlayOpen }),

  collapse: () => {
    saveManuallyCollapsed(true)
    set({ manuallyCollapsed: true, overlayOpen: false })
  },

  expand: () => {
    if (get().autoCollapsed) {
      set({ overlayOpen: true })
      return
    }
    saveManuallyCollapsed(false)
    set({ manuallyCollapsed: false })
  },

  toggle: () => {
    const { autoCollapsed, manuallyCollapsed } = get()
    if (autoCollapsed || manuallyCollapsed) get().expand()
    else get().collapse()
  }
}))
