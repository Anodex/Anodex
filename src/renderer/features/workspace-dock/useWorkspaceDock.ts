import { create } from 'zustand'
import type { DockPanelId } from './workspaceDockTypes'
import { DOCK_PANELS } from './workspaceDockTypes'

interface WorkspaceDockState {
  open: boolean
  enabledPanels: Record<DockPanelId, boolean>
  setOpen: (open: boolean) => void
  togglePanel: (panelId: DockPanelId) => void
}

const ENABLED_PANELS_KEY = 'anodex:dockEnabledPanels'
const OPEN_KEY = 'anodex:dockOpen'

const DEFAULT_ENABLED: Record<DockPanelId, boolean> = Object.fromEntries(
  DOCK_PANELS.map((p) => [p.id, false])
) as Record<DockPanelId, boolean>

function loadEnabledPanels(): Record<DockPanelId, boolean> {
  try {
    const raw = localStorage.getItem(ENABLED_PANELS_KEY)
    if (!raw) return { ...DEFAULT_ENABLED }
    const parsed = JSON.parse(raw) as Partial<Record<DockPanelId, boolean>>
    return DOCK_PANELS.reduce((acc, p) => ({ ...acc, [p.id]: Boolean(parsed[p.id]) }), {
      ...DEFAULT_ENABLED
    })
  } catch {
    return { ...DEFAULT_ENABLED }
  }
}

function saveDockState(open: boolean, enabledPanels: Record<DockPanelId, boolean>): void {
  try {
    localStorage.setItem(ENABLED_PANELS_KEY, JSON.stringify(enabledPanels))
    localStorage.setItem(OPEN_KEY, JSON.stringify(open))
  } catch {
    /* noop */
  }
}

const initialEnabledPanels = loadEnabledPanels()
const initialOpen = (() => {
  try {
    const raw = localStorage.getItem(OPEN_KEY)
    return raw ? (JSON.parse(raw) as boolean) : false
  } catch {
    return false
  }
})()

export const useWorkspaceDock = create<WorkspaceDockState>((set, get) => ({
  open: initialOpen,
  enabledPanels: initialEnabledPanels,

  setOpen: (open) => {
    saveDockState(open, get().enabledPanels)
    set({ open })
  },

  togglePanel: (panelId) =>
    set((s) => {
      const enabledPanels = { ...s.enabledPanels, [panelId]: !s.enabledPanels[panelId] }
      const hasEnabled = DOCK_PANELS.some((p) => enabledPanels[p.id])
      saveDockState(hasEnabled, enabledPanels)
      return { enabledPanels, open: hasEnabled }
    })
}))
