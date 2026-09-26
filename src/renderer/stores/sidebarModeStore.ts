import { create } from 'zustand'

export type SidebarMode = 'chats' | 'workspace'

const MODE_KEY = 'anodex:sidebarMode'

function loadMode(): SidebarMode | null {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    return saved === 'chats' || saved === 'workspace' ? saved : null
  } catch {
    return null
  }
}

/** Keep the last explicit choice while the panel is collapsed or the app restarts. */
interface SidebarModeState {
  mode: SidebarMode | null
  setMode: (mode: SidebarMode) => void
}

export function resolveSidebarMode(
  mode: SidebarMode | null,
  activeProjectId: string | null
): SidebarMode {
  return mode ?? (activeProjectId ? 'workspace' : 'chats')
}

export const useSidebarModeStore = create<SidebarModeState>((set) => ({
  mode: loadMode(),
  setMode: (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      /* noop */
    }
    set({ mode })
  }
}))
