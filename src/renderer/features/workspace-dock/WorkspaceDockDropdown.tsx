import { DEFAULT_KEYBOARD_SHORTCUTS } from '@shared/keyboardShortcuts'
import { Icon } from '../../components/Icon'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkspaceDock } from './useWorkspaceDock'
import { DOCK_PANELS, type DockPanelId } from './workspaceDockTypes'
import styles from './WorkspaceDockDropdown.module.css'

export function WorkspaceDockDropdown(): JSX.Element {
  const enabledPanels = useWorkspaceDock((s) => s.enabledPanels)
  const togglePanel = useWorkspaceDock((s) => s.togglePanel)
  const shortcuts = useSettingsStore((s) => s.settings?.keyboard.shortcuts)

  return (
    <div className={styles.dropdown} role="menu">
      <div className={styles.heading}>Workspace Dock</div>
      <div className={styles.divider} />
      {DOCK_PANELS.map((panel) => {
        const shortcut = shortcutForPanel(panel.id, shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS)
        return (
          <button
            key={panel.id}
            type="button"
            className={styles.item}
            role="menuitemcheckbox"
            aria-checked={enabledPanels[panel.id]}
            onClick={() => togglePanel(panel.id)}
          >
            <span className={styles.icon}>
              <Icon name={panel.icon} size={14} />
            </span>
            <span className={styles.label}>{panel.label}</span>
            {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
            <span className={styles.check}>
              {enabledPanels[panel.id] && <Icon name="check" size={14} />}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function shortcutForPanel(
  panelId: DockPanelId,
  shortcuts: typeof DEFAULT_KEYBOARD_SHORTCUTS
): string {
  if (panelId === 'plan') return shortcuts.toggleDockPlan
  if (panelId === 'files') return shortcuts.toggleDockFiles
  if (panelId === 'terminal') return shortcuts.toggleDockTerminal
  return ''
}
