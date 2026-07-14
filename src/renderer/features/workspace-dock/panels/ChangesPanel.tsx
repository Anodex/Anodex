import { useCallback, useEffect, useState } from 'react'
import type { ChangeSummary } from '@shared/change.types'
import { anodex } from '../../../lib/anodex'
import { Spinner } from '../../../components/ui/Spinner'
import { useProjectStore } from '../../../stores/projectStore'
import { WorkspaceDockPanel } from '../WorkspaceDockPanel'
import styles from './ChangesPanel.module.css'

const STATUS_LABEL: Record<ChangeSummary['status'], string> = {
  proposed: 'Proposed',
  in_progress: 'In progress',
  done: 'Done',
  archived: 'Archived'
}

const CHANGE_TOOL_NAMES = new Set(['propose_change', 'update_change_task', 'archive_change'])

/**
 * Active (non-archived) change proposals for the current project — persisted
 * proposal.md files under `.anodex/changes`, authored via the `propose_change`
 * tool and kept current via `update_change_task`/`archive_change`. Read-only:
 * there's no manual editor, same as the Plan panel has none for `write_plan`.
 */
export function ChangesPanel(): JSX.Element {
  const [changes, setChanges] = useState<ChangeSummary[] | null>(null)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  const refresh = useCallback(async () => {
    const result = await anodex.changes.list(activeProjectId)
    setChanges(result)
  }, [activeProjectId])

  useEffect(() => {
    setChanges(null)
    void refresh()
    return anodex.tools.onActivity((event) => {
      if (event.call.status === 'success' && CHANGE_TOOL_NAMES.has(event.call.name)) void refresh()
    })
  }, [refresh])

  if (changes === null) {
    return (
      <WorkspaceDockPanel title="Changes">
        <div className={styles.loading}>
          <Spinner size={14} />
        </div>
      </WorkspaceDockPanel>
    )
  }

  if (changes.length === 0) {
    return <WorkspaceDockPanel title="Changes">No active changes proposed yet.</WorkspaceDockPanel>
  }

  return (
    <WorkspaceDockPanel title="Changes">
      <ul className={styles.list}>
        {changes.map((change) => {
          const doneCount = change.tasks.filter((task) => task.done).length
          return (
            <li key={change.slug} className={styles.change}>
              <div className={styles.changeHeader}>
                <span className={styles.changeTitle}>{change.title}</span>
                <span className={`${styles.statusBadge} ${styles[`status-${change.status}`]}`}>
                  {STATUS_LABEL[change.status]}
                </span>
              </div>
              {change.tasks.length > 0 && (
                <span className={styles.progress}>
                  {doneCount}/{change.tasks.length} tasks
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </WorkspaceDockPanel>
  )
}
