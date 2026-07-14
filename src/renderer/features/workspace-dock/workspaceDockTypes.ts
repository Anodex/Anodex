import type { IconName } from '../../components/Icon'

export type DockPanelId = 'plan' | 'changes' | 'files' | 'activity' | 'outputs' | 'terminal'

export interface DockPanelConfig {
  id: DockPanelId
  label: string
  icon: IconName
  shortcut?: string
}

export const DOCK_PANELS: DockPanelConfig[] = [
  { id: 'plan', label: 'Plan', icon: 'sparkle', shortcut: 'Ctrl+Shift+P' },
  { id: 'changes', label: 'Changes', icon: 'layers' },
  { id: 'files', label: 'Files', icon: 'folder', shortcut: 'Ctrl+Shift+F' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'outputs', label: 'Outputs', icon: 'monitor' },
  { id: 'terminal', label: 'Terminal', icon: 'monitor', shortcut: 'Ctrl+Shift+T' }
]
