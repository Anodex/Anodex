import { useCallback, useEffect, useState } from 'react'
import type { GitWorkspaceStatus } from '@shared/git.types'
import { Icon } from '../../../components/Icon'
import { Spinner } from '../../../components/ui/Spinner'
import { anodex } from '../../../lib/anodex'
import { notifyError } from '../../../stores/uiStore'
import { WorkspaceDockPanel } from '../WorkspaceDockPanel'
import { useWorkspaceDockProjectId } from '../useWorkspaceDockAvailability'
import styles from './GitPanel.module.css'

export function GitPanel(): JSX.Element {
  const projectId = useWorkspaceDockProjectId()
  const [status, setStatus] = useState<GitWorkspaceStatus | null>(null)
  const [initializing, setInitializing] = useState(false)

  const refresh = useCallback(async () => {
    if (!projectId) {
      setStatus(null)
      return
    }
    const result = await anodex.git.getStatus(projectId)
    if (!result.ok) {
      notifyError('Could not read git status', result.error.message)
      return
    }
    setStatus(result.value)
  }, [projectId])

  useEffect(() => {
    setStatus(null)
    void refresh()
    const unsubscribe = anodex.tools.onActivity((event) => {
      if (event.call.kind === 'write' && event.call.status === 'success') void refresh()
    })
    return unsubscribe
  }, [refresh])

  const initRepo = async (): Promise<void> => {
    if (!projectId || initializing) return
    setInitializing(true)
    try {
      const result = await anodex.git.init(projectId)
      if (!result.ok) {
        notifyError('Could not initialize repository', result.error.message)
        return
      }
      setStatus(result.value)
    } finally {
      setInitializing(false)
    }
  }

  if (!projectId || status === null) {
    return (
      <WorkspaceDockPanel title="Git">
        <div className={styles.loading}>
          <Spinner size={14} />
        </div>
      </WorkspaceDockPanel>
    )
  }

  if (!status.hasRepo) {
    return (
      <WorkspaceDockPanel title="Git">
        <div className={styles.empty}>
          <p>This project isn&apos;t a git repository yet.</p>
          <button
            type="button"
            className={styles.initButton}
            disabled={initializing}
            onClick={() => void initRepo()}
          >
            {initializing ? <Spinner size={13} /> : <Icon name="git-branch" size={13} />}
            Initialize repository
          </button>
        </div>
      </WorkspaceDockPanel>
    )
  }

  return (
    <WorkspaceDockPanel title="Git">
      <div className={styles.status}>
        <div className={styles.branch}>
          <Icon name="git-branch" size={14} className={styles.branchIcon} />
          <span>{status.branch ?? 'detached HEAD'}</span>
        </div>
        {status.filesChanged === 0 ? (
          <span className={styles.clean}>No uncommitted changes</span>
        ) : (
          <div className={styles.diffStat}>
            <span className={styles.filesChanged}>
              {status.filesChanged} file{status.filesChanged === 1 ? '' : 's'} changed
            </span>
            {status.insertions > 0 && (
              <span className={styles.insertions}>+{status.insertions}</span>
            )}
            {status.deletions > 0 && <span className={styles.deletions}>-{status.deletions}</span>}
          </div>
        )}
      </div>
    </WorkspaceDockPanel>
  )
}
