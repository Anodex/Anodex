import { create } from 'zustand'
import type { DockPanelId } from './workspaceDockTypes'
import { DOCK_PANELS } from './workspaceDockTypes'

interface WorkspaceDockState {
  open: boolean
  enabledPanels: Record<DockPanelId, boolean>
  setOpen: (open: boolean) => void
  togglePanel: (panelId: DockPanelId) => void
}

const DEFAULT_ENABLED: Record<DockPanelId, boolean> = Object.fromEntries(
  DOCK_PANELS.map((p) => [p.id, false])
) as Record<DockPanelId, boolean>

export const useWorkspaceDock = create<WorkspaceDockState>((set) => ({
  open: false,
  enabledPanels: { ...DEFAULT_ENABLED },

  setOpen: (open) => set({ open }),

  togglePanel: (panelId) =>
    set((s) => {
      const enabledPanels = { ...s.enabledPanels, [panelId]: !s.enabledPanels[panelId] }
      const hasEnabled = DOCK_PANELS.some((p) => enabledPanels[p.id])
      return { enabledPanels, open: hasEnabled }
    })
}))
