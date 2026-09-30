import type { SidebarMode } from '../../stores/sidebarModeStore'
import { Icon } from '../Icon'
import styles from './SidebarModeSwitcher.module.css'

interface SidebarModeSwitcherProps {
  mode: SidebarMode
  onChange: (mode: SidebarMode) => void
}

/** Title-bar tabs for the two conversation collections. */
export function SidebarModeSwitcher({ mode, onChange }: SidebarModeSwitcherProps): JSX.Element {
  return (
    <div className={styles.switcher} role="group" aria-label="Conversation view">
      <button
        type="button"
        className={`${styles.option} ${mode === 'chats' ? styles.active : ''}`}
        onClick={() => onChange('chats')}
        aria-label="Chats"
        aria-pressed={mode === 'chats'}
        title="Chats"
      >
        <Icon name="chat" size={16} />
      </button>
      <button
        type="button"
        className={`${styles.option} ${mode === 'workspace' ? styles.active : ''}`}
        onClick={() => onChange('workspace')}
        aria-label="Workspace"
        aria-pressed={mode === 'workspace'}
        title="Workspace"
      >
        <Icon name="code" size={17} />
      </button>
    </div>
  )
}
