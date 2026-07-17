import { useState } from 'react'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { Icon } from '../../components/Icon'
import { Overlay } from '../../components/ui/Overlay'
import { Spinner } from '../../components/ui/Spinner'
import { useChatStore, type MessageEditOptions } from '../../stores/chatStore'
import styles from './EditMessageDialog.module.css'

interface EditMessageDialogProps {
  messageId: string
  content: string
  hasAttachments: boolean
  onClose: () => void
}

export function EditMessageDialog({
  messageId,
  content,
  hasAttachments,
  onClose
}: EditMessageDialogProps): JSX.Element {
  const editMessage = useChatStore((state) => state.editMessage)
  const [draft, setDraft] = useState(content)
  const [conflicts, setConflicts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const runEdit = async (options?: MessageEditOptions): Promise<void> => {
    if (busy || (!draft.trim() && !hasAttachments)) return
    setBusy(true)
    try {
      const result = await editMessage(messageId, draft, options)
      if (result.status === 'completed') {
        onClose()
      } else if (result.status === 'conflict') {
        setConflicts(result.conflicts)
      }
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    if (!busy) onClose()
  }

  return (
    <Overlay onClose={close} ariaLabel="Edit message" cardClassName={styles.modal}>
      <header className={styles.header}>
        <span className={styles.headerIcon}>
          <Icon name="pencil" size={16} />
        </span>
        <div className={styles.heading}>
          <h2>Edit message</h2>
          <p>Later replies will be replaced and their file changes rolled back first.</p>
        </div>
        <button type="button" className={styles.closeButton} onClick={close} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className={styles.body}>
        <textarea
          className={styles.editor}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          autoFocus
          rows={7}
          aria-label="Message text"
        />
        {hasAttachments && (
          <div className={styles.attachmentNote}>
            <Icon name="paperclip" size={14} />
            Original attachments will be included again.
          </div>
        )}

        {conflicts.length > 0 && (
          <div className={styles.conflictBox}>
            <div className={styles.warning}>
              <Icon name="alert" size={15} />
              <span>
                These files changed after the discarded replies. Choose whether to keep that newer
                work or restore the earlier state.
              </span>
            </div>
            <div className={styles.fileList}>
              {conflicts.map((path) => (
                <div key={path} className={styles.fileRow} title={path}>
                  <FileTypeIcon fileName={path} size={15} />
                  <span>{path}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className={styles.actions}>
        <button type="button" className={styles.cancelButton} onClick={close} disabled={busy}>
          Cancel
        </button>
        {conflicts.length > 0 && (
          <button
            type="button"
            className={styles.keepButton}
            onClick={() => void runEdit({ keepPaths: conflicts })}
            disabled={busy}
          >
            <Icon name="shield-check" size={15} />
            Keep newer files
          </button>
        )}
        <button
          type="button"
          className={conflicts.length > 0 ? styles.overwriteButton : styles.submitButton}
          onClick={() => void runEdit(conflicts.length > 0 ? { forceRollback: true } : undefined)}
          disabled={busy || (!draft.trim() && !hasAttachments)}
        >
          {busy ? (
            <Spinner size={15} />
          ) : (
            <Icon name={conflicts.length > 0 ? 'restore' : 'send'} size={15} />
          )}
          {busy
            ? 'Updating'
            : conflicts.length > 0
              ? 'Restore all & regenerate'
              : 'Update & regenerate'}
        </button>
      </footer>
    </Overlay>
  )
}
