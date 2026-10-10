import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@shared/keyboardShortcuts'
import type { KeyboardShortcutMap } from '@shared/settings.types'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { StatusDot } from '../../components/ui/StatusDot'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { getActiveProject, useProjectStore } from '../../stores/projectStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useFileViewer } from '../file-viewer/useFileViewer'
import { FileViewerPanel } from '../file-viewer/FileViewerPanel'
import { useWorkspaceDock } from './useWorkspaceDock'
import { useWorkspaceDockProjectId } from './useWorkspaceDockAvailability'
import { useDockStatus, type DockStatus } from './useDockStatus'
import { DOCK_PANELS, type DockPanelId } from './workspaceDockTypes'
import { PlanPanel } from './panels/PlanPanel'
import { ChangesPanel } from './panels/ChangesPanel'
import { CheckpointsPanel } from './panels/CheckpointsPanel'
import { GitPanel } from './panels/GitPanel'
import { FilesPanel } from './panels/FilesPanel'
import { ActivityPanel } from './panels/ActivityPanel'
import { OutputsPanel } from './panels/OutputsPanel'
import { ProcessesPanel } from './panels/ProcessesPanel'
import { ScreenLoading } from '../../components/ui/ScreenLoading'
import styles from './WorkspaceDock.module.css'

// xterm is a third of a megabyte and only the Terminal tab uses it.
const TerminalPanel = lazy(() =>
  import('./panels/TerminalPanel').then((m) => ({ default: m.TerminalPanel }))
)

const PANEL_COMPONENTS: Record<DockPanelId, ComponentType> = {
  plan: PlanPanel,
  changes: ChangesPanel,
  checkpoints: CheckpointsPanel,
  git: GitPanel,
  files: FilesPanel,
  activity: ActivityPanel,
  outputs: OutputsPanel,
  processes: ProcessesPanel,
  terminal: TerminalPanel
}

/** The panels with a shortcut of their own, which their tab's tooltip names. */
function shortcutFor(panel: DockPanelId, shortcuts: KeyboardShortcutMap): string {
  if (panel === 'plan') return shortcuts.toggleDockPlan
  if (panel === 'files') return shortcuts.toggleDockFiles
  if (panel === 'terminal') return shortcuts.toggleDockTerminal
  return ''
}

/** What a tab's badge says, if anything: progress or a count. Activity shows a live dot instead. */
function badgeFor(panel: DockPanelId, status: DockStatus): string | null {
  switch (panel) {
    case 'plan':
      return status.plan ? `${status.plan.done}/${status.plan.total}` : null
    case 'changes':
      return status.changeCount ? String(status.changeCount) : null
    case 'checkpoints':
      return status.checkpointCount ? String(status.checkpointCount) : null
    case 'git':
      return status.git?.filesChanged ? String(status.git.filesChanged) : null
    case 'outputs':
      return status.outputCount ? String(status.outputCount) : null
    case 'processes':
      return status.runningProcesses ? String(status.runningProcesses) : null
    default:
      return null
  }
}

/**
 * The right-hand workspace dock: one panel at a time, picked from a tab strip
 * down its edge. Each tab carries what its panel would tell you at a glance
 * (plan progress, how many changes, a live dot while Anodex is working) so the
 * dock reads as a status board even before a panel is opened, and a footer
 * sums up the project.
 */
export function WorkspaceDock(): JSX.Element | null {
  const open = useWorkspaceDock((s) => s.open)
  const setOpen = useWorkspaceDock((s) => s.setOpen)
  const activePanel = useWorkspaceDock((s) => s.activePanel)
  const showPanel = useWorkspaceDock((s) => s.showPanel)
  const openFile = useFileViewer((s) => s.node)
  const closeFile = useFileViewer((s) => s.close)
  const projectId = useWorkspaceDockProjectId()
  const project = useProjectStore((s) => getActiveProject(s.projects, projectId))
  const status = useDockStatus()
  const shortcuts =
    useSettingsStore((s) => s.settings?.keyboard.shortcuts) ?? DEFAULT_KEYBOARD_SHORTCUTS
  const tabRefs = useRef(new Map<DockPanelId, HTMLButtonElement>())

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, setOpen])

  if (!open) return null

  const panel = DOCK_PANELS.find((p) => p.id === activePanel) ?? DOCK_PANELS[0]
  const Panel = PANEL_COMPONENTS[panel.id]

  const select = (id: DockPanelId): void => {
    if (openFile) closeFile()
    showPanel(id)
  }

  // Arrow keys move along the strip, as a vertical tab list should.
  const handleTabKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const index = DOCK_PANELS.findIndex((p) => p.id === panel.id)
    const nextIndex =
      event.key === 'ArrowDown'
        ? (index + 1) % DOCK_PANELS.length
        : event.key === 'ArrowUp'
          ? (index - 1 + DOCK_PANELS.length) % DOCK_PANELS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? DOCK_PANELS.length - 1
              : null
    if (nextIndex === null) return
    event.preventDefault()
    const next = DOCK_PANELS[nextIndex].id
    select(next)
    tabRefs.current.get(next)?.focus()
  }

  return (
    <aside className={styles.dock} aria-label="Workspace Dock">
      <div
        className={styles.tabs}
        role="tablist"
        aria-orientation="vertical"
        aria-label="Dock panels"
        onKeyDown={handleTabKey}
      >
        {DOCK_PANELS.map((p) => {
          const selected = p.id === panel.id && !openFile
          const badge = badgeFor(p.id, status)
          return (
            <button
              key={p.id}
              ref={(node) => {
                if (node) tabRefs.current.set(p.id, node)
                else tabRefs.current.delete(p.id)
              }}
              type="button"
              role="tab"
              id={`dock-tab-${p.id}`}
              aria-selected={selected}
              aria-controls="dock-panel"
              tabIndex={p.id === panel.id ? 0 : -1}
              className={`${styles.tab} ${selected ? styles.tabActive : ''}`}
              onClick={() => select(p.id)}
              title={
                shortcutFor(p.id, shortcuts)
                  ? `${p.label} · ${shortcutFor(p.id, shortcuts)}`
                  : p.label
              }
            >
              <Icon name={p.icon} size={16} />
              {p.id === 'activity' && status.working ? (
                <span className={styles.live}>
                  <StatusDot tone="running" />
                </span>
              ) : (
                badge && <span className={styles.badge}>{badge}</span>
              )}
            </button>
          )
        })}
      </div>

      <div className={styles.main}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <span className={styles.heading}>{openFile ? openFile.name : panel.label}</span>
            {project && <span className={styles.project}>{project.name}</span>}
          </div>
          <IconButton
            label="Close dock"
            icon={<Icon name="close" size={14} />}
            size="sm"
            onClick={() => setOpen(false)}
          />
        </div>

        <div
          className={styles.body}
          role="tabpanel"
          id="dock-panel"
          aria-labelledby={openFile ? undefined : `dock-tab-${panel.id}`}
        >
          {openFile ? (
            <ErrorBoundary label="File viewer">
              <FileViewerPanel />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary key={panel.id} label={`${panel.label} panel`}>
              <div key={panel.id} className={styles.panelIn}>
                <Suspense fallback={<ScreenLoading />}>
                  <Panel />
                </Suspense>
              </div>
            </ErrorBoundary>
          )}
        </div>

        <DockFooter status={status} />
      </div>
    </aside>
  )
}

/** The project at a glance: whether Anodex is working, the branch and its diff, the restore points. */
function DockFooter({ status }: { status: DockStatus }): JSX.Element {
  const { git } = status
  return (
    <div className={styles.footer}>
      <span className={styles.footerItem}>
        <StatusDot tone={status.working ? 'running' : 'neutral'} />
        {status.working ? 'Working' : 'Idle'}
      </span>
      {git?.hasRepo ? (
        <span className={styles.footerItem} title={git.upstream ?? undefined}>
          <Icon name="git-branch" size={12} />
          <span className={styles.branch}>{git.branch ?? 'detached'}</span>
          {git.filesChanged > 0 && (
            <>
              <span className={styles.added}>+{git.insertions}</span>
              <span className={styles.removed}>−{git.deletions}</span>
            </>
          )}
        </span>
      ) : (
        git && (
          <span className={styles.footerItem}>
            <Icon name="git-branch" size={12} />
            No repository
          </span>
        )
      )}
      {Boolean(status.checkpointCount) && (
        <span
          className={`${styles.footerItem} ${styles.footerEnd}`}
          title={`${status.checkpointCount} restore point${status.checkpointCount === 1 ? '' : 's'}`}
        >
          <Icon name="restore" size={12} />
          {status.checkpointCount}
        </span>
      )}
    </div>
  )
}
