import { useSettingsStore } from '../../stores/settingsStore'
import { Icon } from '../../components/Icon'
import styles from './WorkspaceControl.module.css'

function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

/**
 * Read-only workspace indicator shown above the composer in a project chat.
 * The workspace is always the open project's own folder — there's no option
 * to set or change it from the chat itself; that's a project action (Settings
 * → Projects), not a chat one, so editing always happens somewhere organized.
 */
export function WorkspaceControl(): JSX.Element | null {
  const root = useSettingsStore((s) => s.settings?.workspace.root ?? null)
  const toolsEnabled = useSettingsStore((s) => s.settings?.tools.enabled ?? true)

  if (!toolsEnabled || !root) return null

  return (
    <div className={styles.bar}>
      <Icon name="folder" size={14} />
      <span className={styles.label}>Workspace</span>
      <span className={styles.name} title={root}>
        {baseName(root)}
      </span>
    </div>
  )
}
