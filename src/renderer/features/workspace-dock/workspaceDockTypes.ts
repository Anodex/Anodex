import type { IconName } from '../../components/Icon'

export type DockPanelId = 'plan' | 'files' | 'activity' | 'outputs'

export interface DockPanelConfig {
  id: DockPanelId
  label: string
  icon: IconName
  shortcut?: string
}

export const DOCK_PANELS: DockPanelConfig[] = [
  { id: 'plan', label: 'Plan', icon: 'sparkle', shortcut: 'Ctrl+Shift+P' },
  { id: 'files', label: 'Files', icon: 'folder', shortcut: 'Ctrl+Shift+F' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'outputs', label: 'Outputs', icon: 'monitor' }
]
