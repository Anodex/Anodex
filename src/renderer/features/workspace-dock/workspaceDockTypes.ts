import type { IconName } from '../../components/Icon'

export type DockPanelId =
  'plan' | 'changes' | 'checkpoints' | 'git' | 'files' | 'activity' | 'outputs' | 'terminal'

export interface DockPanelConfig {
  id: DockPanelId
  label: string
  icon: IconName
}

export const DOCK_PANELS: DockPanelConfig[] = [
  { id: 'plan', label: 'Plan', icon: 'plan' },
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'checkpoints', label: 'Checkpoints', icon: 'restore' },
  { id: 'git', label: 'Git', icon: 'git-branch' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'outputs', label: 'Outputs', icon: 'file' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' }
]
