import { Overlay } from '../../../components/ui/Overlay'
import { Icon } from '../../../components/Icon'
import styles from './DeleteConfirmDialog.module.css'

interface DeleteConfirmDialogProps {
  name: string
  isFolder: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Blocking confirmation before deleting a file/folder from the Files panel —
 * the one destructive action in that menu, so it gets its own dialog rather
 * than a plain `window.confirm()`, with danger (not accent) coloring to read
 * as irreversible-feeling even though the delete itself goes to the OS
 * Recycle Bin. Uses the shared `Overlay` chrome (backdrop, card, Escape-to-close).
 */
export function DeleteConfirmDialog({
  name,
  isFolder,
  onCancel,
  onConfirm
}: DeleteConfirmDialogProps): JSX.Element {
  return (
    <Overlay onClose={onCancel} ariaLabel="Delete confirmation" cardClassName={styles.modal}>
      <div className={styles.header}>
        <span className={styles.badge}>
          <Icon name="trash" size={16} />
        </span>
        <div>
          <div className={styles.title}>Delete {isFolder ? 'folder' : 'file'}?</div>
          <div className={styles.subtitle}>
            {isFolder
              ? 'This moves the folder and everything inside it to the Recycle Bin.'
              : 'This moves the file to the Recycle Bin.'}
          </div>
        </div>
      </div>

      <div className={styles.name}>{name}</div>

      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={styles.confirm} onClick={onConfirm}>
          <Icon name="trash" size={15} />
          Move to Recycle Bin
        </button>
      </div>
    </Overlay>
  )
}
