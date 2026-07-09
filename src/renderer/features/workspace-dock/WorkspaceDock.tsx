import { useEffect } from 'react'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { useFileViewer } from '../file-viewer/useFileViewer'
import { FileViewerPanel } from '../file-viewer/FileViewerPanel'
import { useWorkspaceDock } from './useWorkspaceDock'
import { DOCK_PANELS } from './workspaceDockTypes'
import { PlanPanel } from './panels/PlanPanel'
import { FilesPanel } from './panels/FilesPanel'
import { ActivityPanel } from './panels/ActivityPanel'
import { OutputsPanel } from './panels/OutputsPanel'
import { TerminalPanel } from './panels/TerminalPanel'
import styles from './WorkspaceDock.module.css'

const PANEL_COMPONENTS = {
  plan: PlanPanel,
  files: FilesPanel,
  activity: ActivityPanel,
  outputs: OutputsPanel,
  terminal: TerminalPanel
} as const

const PANEL_LABELS: Record<keyof typeof PANEL_COMPONENTS, string> = {
  plan: 'Plan panel',
  files: 'File tree',
  activity: 'Activity panel',
  outputs: 'Outputs panel',
  terminal: 'Terminal'
}

/** Right-side workspace dock that shows selected panels. */
export function WorkspaceDock(): JSX.Element | null {
  const open = useWorkspaceDock((s) => s.open)
  const setOpen = useWorkspaceDock((s) => s.setOpen)
  const enabledPanels = useWorkspaceDock((s) => s.enabledPanels)
  const openFile = useFileViewer((s) => s.node)

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, setOpen])

  if (!open) return null

  const visiblePanels = DOCK_PANELS.filter((p) => enabledPanels[p.id])

  return (
    <aside className={styles.dock}>
      <div className={styles.header}>
        <span className={styles.heading}>Workspace Dock</span>
        <IconButton
          label="Close dock"
          icon={<Icon name="close" size={14} />}
          size="sm"
          onClick={() => setOpen(false)}
        />
      </div>
      <div className={styles.body}>
        {openFile ? (
          <ErrorBoundary label="File viewer">
            <FileViewerPanel />
          </ErrorBoundary>
        ) : visiblePanels.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>No dock panels selected.</div>
            <div className={styles.emptyHint}>Use the Dock menu to choose what appears here.</div>
          </div>
        ) : (
          visiblePanels.map((panel) => {
            const Panel = PANEL_COMPONENTS[panel.id]
            return (
              <ErrorBoundary key={panel.id} label={PANEL_LABELS[panel.id]}>
                <Panel />
              </ErrorBoundary>
            )
          })
        )}
      </div>
    </aside>
  )
}
