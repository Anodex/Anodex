import { create } from 'zustand'
import type { DockPanelId } from './workspaceDockTypes'
import { DOCK_PANELS } from './workspaceDockTypes'

interface WorkspaceDockState {
  open: boolean
  /** The panel the dock shows. One at a time, chosen from the dock's tab strip. */
  activePanel: DockPanelId
  setOpen: (open: boolean) => void
  /** Open the dock on a panel. */
  showPanel: (panelId: DockPanelId) => void
  /**
   * What a panel's shortcut does: open the dock on that panel, or close it when
   * that panel is already the one showing.
   */
  togglePanel: (panelId: DockPanelId) => void
}

const ACTIVE_PANEL_KEY = 'anodex:dockActivePanel'
const OPEN_KEY = 'anodex:dockOpen'
/** The stacked dock's record of which panels were switched on; read once to pick a first tab. */
const LEGACY_ENABLED_PANELS_KEY = 'anodex:dockEnabledPanels'

function isPanelId(value: unknown): value is DockPanelId {
  return DOCK_PANELS.some((panel) => panel.id === value)
}

function loadActivePanel(): DockPanelId {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(ACTIVE_PANEL_KEY) ?? 'null')
    if (isPanelId(stored)) return stored
    // Someone who used the stacked dock had chosen panels; open on the first
    // of them rather than on a panel they had switched off.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_ENABLED_PANELS_KEY) ?? '{}') as Partial<
      Record<DockPanelId, boolean>
    >
    return DOCK_PANELS.find((panel) => legacy[panel.id])?.id ?? DOCK_PANELS[0].id
  } catch {
    return DOCK_PANELS[0].id
  }
}

function loadOpen(): boolean {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'false') === true
  } catch {
    return false
  }
}

function save(open: boolean, activePanel: DockPanelId): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(open))
    localStorage.setItem(ACTIVE_PANEL_KEY, JSON.stringify(activePanel))
  } catch {
    /* storage unavailable: the dock still works, it just will not remember */
  }
}

export const useWorkspaceDock = create<WorkspaceDockState>((set, get) => ({
  open: loadOpen(),
  activePanel: loadActivePanel(),

  setOpen: (open) => {
    save(open, get().activePanel)
    set({ open })
  },

  showPanel: (activePanel) => {
    save(true, activePanel)
    set({ open: true, activePanel })
  },

  togglePanel: (panelId) => {
    const { open, activePanel } = get()
    if (open && activePanel === panelId) get().setOpen(false)
    else get().showPanel(panelId)
  }
}))
