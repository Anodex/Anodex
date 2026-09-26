import { create } from 'zustand'

/** Keep the 52px rail and a useful chat area when the project/chat panel is open. */
export const SIDEBAR_RAIL_WIDTH = 52
export const SIDEBAR_COLLAPSE_BREAKPOINT = 812

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
  /** Consumed by the search input after the panel opens and focus moves. */
  searchFocusPending: boolean
  setAutoCollapsed: (value: boolean) => void
  setOverlayOpen: (value: boolean) => void
  requestSearch: () => void
  clearSearchFocus: () => void
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
  searchFocusPending: false,

  setAutoCollapsed: (autoCollapsed) => {
    set({ autoCollapsed })
    if (!autoCollapsed) set({ overlayOpen: false })
  },

  setOverlayOpen: (overlayOpen) => set({ overlayOpen }),

  requestSearch: () => {
    get().expand()
    set({ searchFocusPending: true })
  },

  clearSearchFocus: () => set({ searchFocusPending: false }),

  collapse: () => {
    saveManuallyCollapsed(true)
    set({ manuallyCollapsed: true, overlayOpen: false, searchFocusPending: false })
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
    const { autoCollapsed, manuallyCollapsed, overlayOpen } = get()
    if (overlayOpen) set({ overlayOpen: false })
    else if (autoCollapsed || manuallyCollapsed) get().expand()
    else get().collapse()
  }
}))
