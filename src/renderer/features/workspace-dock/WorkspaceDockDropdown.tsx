import { Icon } from '../../components/Icon'
import { useWorkspaceDock } from './useWorkspaceDock'
import { DOCK_PANELS } from './workspaceDockTypes'
import styles from './WorkspaceDockDropdown.module.css'

export function WorkspaceDockDropdown(): JSX.Element {
  const enabledPanels = useWorkspaceDock((s) => s.enabledPanels)
  const togglePanel = useWorkspaceDock((s) => s.togglePanel)

  return (
    <div className={styles.dropdown} role="menu">
      <div className={styles.heading}>Workspace Dock</div>
      <div className={styles.divider} />
      {DOCK_PANELS.map((panel) => (
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
          {panel.shortcut && <span className={styles.shortcut}>{panel.shortcut}</span>}
          <span className={styles.check}>
            {enabledPanels[panel.id] && <Icon name="check" size={14} />}
          </span>
        </button>
      ))}
    </div>
  )
}
