import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { useWorkspaceDock } from './useWorkspaceDock'
import { useDockKeyboardShortcuts } from './useDockKeyboardShortcuts'
import { useWorkspaceDockProjectId } from './useWorkspaceDockAvailability'
import styles from './WorkspaceDockButton.module.css'

/**
 * Top-right button that opens and closes the dock. Choosing a panel happens in
 * the dock's own tab strip, so the button no longer carries a hover menu of
 * panels to switch on and off.
 */
export function WorkspaceDockButton(): JSX.Element | null {
  const dockOpen = useWorkspaceDock((s) => s.open)
  const setDockOpen = useWorkspaceDock((s) => s.setOpen)
  const dockProjectId = useWorkspaceDockProjectId()

  useDockKeyboardShortcuts(Boolean(dockProjectId))

  if (!dockProjectId) return null

  return (
    <IconButton
      label={dockOpen ? 'Collapse workspace dock' : 'Expand workspace dock'}
      icon={<Icon name="panel-right" size={18} />}
      data-tour="dock"
      size="sm"
      className={dockOpen ? styles.active : undefined}
      onClick={() => setDockOpen(!dockOpen)}
    />
  )
}
