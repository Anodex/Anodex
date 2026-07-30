import { FileTypeIcon } from '../../components/FileTypeIcon'
import { Icon } from '../../components/Icon'
import { Overlay } from '../../components/ui/Overlay'
import { Spinner } from '../../components/ui/Spinner'
import type { MessageEditOptions } from '../../stores/chatStore'
import styles from './RegenerateDialog.module.css'

interface RegenerateDialogProps {
  /** Turns after the one being regenerated, all of which are discarded. */
  laterTurnCount: number
  /** Files changed after the discarded replies, if the rollback hit any. */
  conflicts: string[] | null
  busy: boolean
  onRun: (options?: MessageEditOptions) => void
  onClose: () => void
}

/**
 * The two questions regenerating can raise, and nothing else.
 *
 * Regenerating the newest reply with no file conflicts asks neither, so
 * `MessageBubble` runs it directly and never mounts this — a reply that
 * stalled is something the user wants gone in one click, not after a
 * confirmation they will dismiss every time. This appears only when there is
 * genuinely something to lose: later turns that would be discarded, or files
 * changed since the reply being replaced.
 */
export function RegenerateDialog({
  laterTurnCount,
  conflicts,
  busy,
  onRun,
  onClose
}: RegenerateDialogProps): JSX.Element {
  const hasConflicts = conflicts !== null && conflicts.length > 0
  const close = (): void => {
    if (!busy) onClose()
  }

  return (
    <Overlay onClose={close} ariaLabel="Regenerate reply" cardClassName={styles.modal}>
      <header className={styles.header}>
        <span className={hasConflicts ? styles.headerIconWarn : styles.headerIcon}>
          <Icon name={hasConflicts ? 'alert' : 'rotate-ccw'} size={16} />
        </span>
        <div className={styles.heading}>
          <h2>{hasConflicts ? 'Files changed since that reply' : 'Regenerate this reply?'}</h2>
          <p>
            {hasConflicts
              ? 'Choose whether to keep that newer work or restore the state from before the discarded replies.'
              : `The same message will be sent again. ${laterTurnCount === 1 ? 'The turn' : `The ${laterTurnCount} turns`} after this reply will be discarded, and any file changes rolled back.`}
          </p>
        </div>
        <button type="button" className={styles.closeButton} onClick={close} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </header>

      {hasConflicts && (
        <div className={styles.fileList}>
          {conflicts.map((path) => (
            <div key={path} className={styles.fileRow} title={path}>
              <FileTypeIcon fileName={path} size={15} />
              <span>{path}</span>
            </div>
          ))}
        </div>
      )}

      <footer className={styles.actions}>
        <button type="button" className={styles.cancelButton} onClick={close} disabled={busy}>
          Cancel
        </button>
        {hasConflicts && (
          <button
            type="button"
            className={styles.keepButton}
            onClick={() => onRun({ keepPaths: conflicts })}
            disabled={busy}
          >
            <Icon name="shield-check" size={15} />
            Keep newer files
          </button>
        )}
        <button
          type="button"
          className={hasConflicts ? styles.overwriteButton : styles.submitButton}
          onClick={() => onRun(hasConflicts ? { forceRollback: true } : undefined)}
          disabled={busy}
        >
          {busy ? (
            <Spinner size={15} />
          ) : (
            <Icon name={hasConflicts ? 'restore' : 'rotate-ccw'} size={15} />
          )}
          {busy ? 'Regenerating' : hasConflicts ? 'Restore all & regenerate' : 'Regenerate'}
        </button>
      </footer>
    </Overlay>
  )
}
