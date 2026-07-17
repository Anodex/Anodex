import { useEffect, useState } from 'react'
import type { CheckpointFilePreview, CheckpointPreview } from '@shared/checkpoint.types'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { Icon } from '../../components/Icon'
import { Overlay } from '../../components/ui/Overlay'
import { Spinner } from '../../components/ui/Spinner'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { DiffView } from './DiffView'
import styles from './CheckpointDialog.module.css'

interface CheckpointDialogProps {
  conversationId: string
  messageId: string
  onClose: () => void
}

export function CheckpointDialog({
  conversationId,
  messageId,
  onClose
}: CheckpointDialogProps): JSX.Element {
  const inspectCheckpoint = useChatStore((state) => state.inspectCheckpoint)
  const restoreCheckpoint = useChatStore((state) => state.restoreCheckpoint)
  const diffMode = useSettingsStore((state) => state.settings?.appearance.diffView ?? 'unified')
  const [preview, setPreview] = useState<CheckpointPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState(false)
  const [lateConflicts, setLateConflicts] = useState(false)

  useEffect(() => {
    let active = true
    void inspectCheckpoint(conversationId, messageId).then((result) => {
      if (!active) return
      setPreview(result)
      setSelected(
        result?.files
          .filter((file) => !file.restored && !file.conflicted)
          .map((file) => file.path) ?? []
      )
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [conversationId, inspectCheckpoint, messageId])

  const remainingFiles = preview?.files.filter((file) => !file.restored) ?? []
  const safeFiles = remainingFiles.filter((file) => !file.conflicted)
  const selectedConflicts =
    preview?.files.filter((file) => selected.includes(file.path) && file.conflicted) ?? []
  const allSafeSelected =
    safeFiles.length > 0 && safeFiles.every((file) => selected.includes(file.path))

  const toggleFile = (path: string): void => {
    setSelected((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path]
    )
  }

  const toggleSafeFiles = (): void => {
    const safePaths = new Set(safeFiles.map((file) => file.path))
    setSelected((current) =>
      allSafeSelected
        ? current.filter((path) => !safePaths.has(path))
        : [...new Set([...current, ...safePaths])]
    )
  }

  const handleRestore = async (): Promise<void> => {
    if (selected.length === 0 || restoring) return
    setRestoring(true)
    setLateConflicts(false)
    try {
      const result = await restoreCheckpoint(
        conversationId,
        messageId,
        selected,
        selectedConflicts.length > 0
      )
      if (!result) return
      if (result.conflicts.length > 0) {
        const conflicts = new Set(result.conflicts)
        setPreview((current) =>
          current
            ? {
                ...current,
                files: current.files.map((file) =>
                  conflicts.has(file.path) ? { ...file, conflicted: true } : file
                )
              }
            : current
        )
        setSelected((current) => current.filter((path) => !conflicts.has(path)))
        setLateConflicts(true)
        return
      }

      const refreshed = await inspectCheckpoint(conversationId, messageId)
      if (refreshed) setPreview(refreshed)
      setSelected([])
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Overlay onClose={onClose} ariaLabel="Review checkpoint" cardClassName={styles.modal}>
      <header className={styles.header}>
        <span className={styles.headerIcon}>
          <Icon name="restore" size={17} />
        </span>
        <div className={styles.heading}>
          <h2>Restore checkpoint</h2>
          <p>Review the files changed by this turn and choose what to restore.</p>
        </div>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className={styles.body}>
        {loading ? (
          <div className={styles.loading}>
            <Spinner size={18} />
            Checking files
          </div>
        ) : !preview ? (
          <div className={styles.empty}>This checkpoint could not be loaded.</div>
        ) : (
          <>
            <div className={styles.selectionBar}>
              <label className={styles.selectSafe}>
                <input
                  type="checkbox"
                  checked={allSafeSelected}
                  disabled={safeFiles.length === 0}
                  onChange={toggleSafeFiles}
                />
                Select safe files
              </label>
              <span>
                {selected.length} of {remainingFiles.length} remaining selected
              </span>
            </div>

            {(lateConflicts || remainingFiles.some((file) => file.conflicted)) && (
              <div className={styles.warning}>
                <Icon name="alert" size={15} />
                <span>
                  {lateConflicts
                    ? 'Some files changed while this dialog was open. Review them before restoring.'
                    : 'Changed-again files contain newer work. They are not selected automatically.'}
                </span>
              </div>
            )}

            <div className={styles.fileList}>
              {preview.files.map((file) => (
                <CheckpointFileRow
                  key={file.path}
                  file={file}
                  selected={selected.includes(file.path)}
                  expanded={expanded === file.path}
                  diffMode={diffMode}
                  onToggle={() => toggleFile(file.path)}
                  onExpand={() =>
                    setExpanded((current) => (current === file.path ? null : file.path))
                  }
                />
              ))}
            </div>
          </>
        )}
      </div>

      <footer className={styles.actions}>
        <button type="button" className={styles.cancelButton} onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className={`${styles.restoreButton} ${selectedConflicts.length > 0 ? styles.overwrite : ''}`}
          disabled={!preview || selected.length === 0 || restoring}
          onClick={() => void handleRestore()}
        >
          {restoring ? <Spinner size={15} /> : <Icon name="restore" size={15} />}
          {restoring
            ? 'Restoring'
            : selectedConflicts.length > 0
              ? `Overwrite and restore ${selected.length}`
              : `Restore ${selected.length}`}
        </button>
      </footer>
    </Overlay>
  )
}

function CheckpointFileRow({
  file,
  selected,
  expanded,
  diffMode,
  onToggle,
  onExpand
}: {
  file: CheckpointFilePreview
  selected: boolean
  expanded: boolean
  diffMode: 'unified' | 'sideBySide'
  onToggle: () => void
  onExpand: () => void
}): JSX.Element {
  return (
    <div className={`${styles.fileItem} ${file.conflicted ? styles.conflicted : ''}`}>
      <div className={styles.fileRow}>
        <input
          type="checkbox"
          checked={selected}
          disabled={file.restored}
          onChange={onToggle}
          aria-label={`Restore ${file.path}`}
        />
        <button type="button" className={styles.fileButton} onClick={onExpand}>
          <FileTypeIcon fileName={file.path} size={15} />
          <span className={styles.filePath} title={file.path}>
            {file.path}
          </span>
          <span className={`${styles.kind} ${styles[file.kind]}`}>{file.kind}</span>
          {file.restored && (
            <span className={styles.restoredStatus}>
              <Icon name="check" size={12} /> Restored
            </span>
          )}
          {file.conflicted && (
            <span className={styles.conflictStatus} title="This file changed after the AI turn">
              <Icon name="alert" size={12} /> Changed again
            </span>
          )}
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
        </button>
      </div>
      {expanded && (
        <div className={styles.diffWrap}>
          <DiffView
            before={file.before ?? ''}
            after={file.after ?? ''}
            mode={diffMode}
            path={file.path}
          />
        </div>
      )}
    </div>
  )
}
