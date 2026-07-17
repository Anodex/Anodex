import { useCallback, useEffect, useState } from 'react'
import type { CheckpointHistoryEntry } from '@shared/checkpoint.types'
import { FileTypeIcon } from '../../../components/FileTypeIcon'
import { Icon } from '../../../components/Icon'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { Spinner } from '../../../components/ui/Spinner'
import { CheckpointDialog } from '../../chat/CheckpointDialog'
import { anodex } from '../../../lib/anodex'
import { useChatStore } from '../../../stores/chatStore'
import { notifyError, useUiStore } from '../../../stores/uiStore'
import { WorkspaceDockPanel } from '../WorkspaceDockPanel'
import { useWorkspaceDockProjectId } from '../useWorkspaceDockAvailability'
import styles from './CheckpointsPanel.module.css'

interface PendingUndo {
  entry: CheckpointHistoryEntry
  conflicts: string[]
}

export function CheckpointsPanel(): JSX.Element {
  const projectId = useWorkspaceDockProjectId()
  const conversations = useChatStore((state) => state.conversations)
  const syncCheckpointSummary = useChatStore((state) => state.syncCheckpointSummary)
  const notify = useUiStore((state) => state.notify)
  const [entries, setEntries] = useState<CheckpointHistoryEntry[] | null>(null)
  const [reviewing, setReviewing] = useState<CheckpointHistoryEntry | null>(null)
  const [undoing, setUndoing] = useState<string | null>(null)
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null)

  const refresh = useCallback(async () => {
    if (!projectId) {
      setEntries([])
      return
    }
    const result = await anodex.checkpoints.list(projectId)
    if (!result.ok) {
      notifyError('Could not load checkpoints', result.error.message)
      setEntries([])
      return
    }
    setEntries(result.value)
  }, [projectId])

  useEffect(() => {
    setEntries(null)
    void refresh()
    const unsubscribe = anodex.tools.onActivity((event) => {
      if (event.call.kind === 'write' && event.call.status === 'success') void refresh()
    })
    const handleChanged = (): void => void refresh()
    window.addEventListener('anodex:checkpoints-changed', handleChanged)
    return () => {
      unsubscribe()
      window.removeEventListener('anodex:checkpoints-changed', handleChanged)
    }
  }, [refresh])

  const undoRestore = async (entry: CheckpointHistoryEntry, force = false): Promise<void> => {
    if (!projectId || undoing) return
    const restoredFiles = entry.restoredFiles ?? []
    if (restoredFiles.length === 0) return
    setUndoing(entry.messageId)
    try {
      const result = await anodex.checkpoints.undo({
        projectId,
        conversationId: entry.conversationId,
        messageId: entry.messageId,
        paths: restoredFiles,
        force
      })
      if (!result.ok) {
        notifyError('Could not undo restore', result.error.message)
        return
      }
      if (result.value.conflicts.length > 0) {
        setPendingUndo({ entry, conflicts: result.value.conflicts })
        return
      }
      if (result.value.undoneFiles.length > 0) {
        syncCheckpointSummary(entry.conversationId, entry.messageId, result.value.checkpoint)
        notify({
          kind: 'success',
          title: 'Restore undone',
          message: `Reapplied ${result.value.undoneFiles.length} file${
            result.value.undoneFiles.length === 1 ? '' : 's'
          } from the AI turn.`
        })
        window.dispatchEvent(new Event('anodex:checkpoints-changed'))
      }
      await refresh()
    } finally {
      setUndoing(null)
    }
  }

  return (
    <WorkspaceDockPanel title="Checkpoints">
      {entries === null ? (
        <div className={styles.loading}>
          <Spinner size={14} />
        </div>
      ) : entries.length === 0 ? (
        <div className={styles.empty}>No file checkpoints yet.</div>
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => {
            const conversation = conversations.find((item) => item.id === entry.conversationId)
            const restoredCount = entry.restoredFiles?.length ?? 0
            return (
              <li key={`${entry.conversationId}:${entry.messageId}`} className={styles.entry}>
                <div className={styles.entryHeader}>
                  <span className={styles.title} title={conversation?.title}>
                    {conversation?.title ?? 'Previous conversation'}
                  </span>
                  <span className={styles.time}>{formatCheckpointTime(entry.createdAt)}</span>
                </div>
                <div className={styles.files}>
                  {entry.changedFiles.slice(0, 3).map((path) => (
                    <span key={path} className={styles.file} title={path}>
                      <FileTypeIcon fileName={path} size={13} />
                      <span>{path}</span>
                    </span>
                  ))}
                  {entry.changedFiles.length > 3 && (
                    <span className={styles.more}>+{entry.changedFiles.length - 3} more</span>
                  )}
                </div>
                <div className={styles.entryFooter}>
                  <CheckpointStatus restored={restoredCount} total={entry.changedFiles.length} />
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() => setReviewing(entry)}
                    title="Review checkpoint"
                  >
                    <Icon name="eye" size={13} />
                    Review
                  </button>
                  {restoredCount > 0 && (
                    <button
                      type="button"
                      className={styles.actionButton}
                      disabled={undoing === entry.messageId}
                      onClick={() => void undoRestore(entry)}
                      title="Reapply the AI turn for restored files"
                    >
                      {undoing === entry.messageId ? (
                        <Spinner size={13} />
                      ) : (
                        <Icon name="refresh" size={13} />
                      )}
                      Undo restore
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {reviewing && projectId && (
        <CheckpointDialog
          projectId={projectId}
          conversationId={reviewing.conversationId}
          messageId={reviewing.messageId}
          onClose={() => {
            setReviewing(null)
            void refresh()
          }}
        />
      )}

      {pendingUndo && (
        <ConfirmDialog
          title="Overwrite newer file changes?"
          message="These files changed after the restore. Undoing it will replace that newer work."
          detail={pendingUndo.conflicts.join('\n')}
          confirmLabel="Overwrite and undo"
          icon="refresh"
          onCancel={() => setPendingUndo(null)}
          onConfirm={() => {
            const pending = pendingUndo
            setPendingUndo(null)
            void undoRestore(pending.entry, true)
          }}
        />
      )}
    </WorkspaceDockPanel>
  )
}

function CheckpointStatus({ restored, total }: { restored: number; total: number }): JSX.Element {
  if (restored === 0) return <span className={styles.readyStatus}>Ready</span>
  if (restored === total) return <span className={styles.restoredStatus}>Restored</span>
  return (
    <span className={styles.partialStatus}>
      {restored}/{total} restored
    </span>
  )
}

function formatCheckpointTime(createdAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(createdAt)
}
