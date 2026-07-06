import { Overlay } from '../../components/ui/Overlay'
import { Icon } from '../../components/Icon'
import styles from './UnsavedChangesDialog.module.css'

interface UnsavedChangesDialogProps {
  name: string
  onCancel: () => void
  onDiscard: () => void
  onSave: () => void
}

/**
 * Blocking confirmation shown when closing a dirty file in the viewer/editor,
 * modeled on the Files panel's `DeleteConfirmDialog` (same `Overlay` chrome,
 * same header/name/actions shape) with a third "Save" action instead of one
 * destructive confirm.
 */
export function UnsavedChangesDialog({
  name,
  onCancel,
  onDiscard,
  onSave
}: UnsavedChangesDialogProps): JSX.Element {
  return (
    <Overlay onClose={onCancel} ariaLabel="Unsaved changes" cardClassName={styles.modal}>
      <div className={styles.header}>
        <span className={styles.badge}>
          <Icon name="alert" size={16} />
        </span>
        <div>
          <div className={styles.title}>Unsaved changes</div>
          <div className={styles.subtitle}>Save your edits before closing, or discard them.</div>
        </div>
      </div>

      <div className={styles.name}>{name}</div>

      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={styles.discard} onClick={onDiscard}>
          <Icon name="trash" size={15} />
          Discard
        </button>
        <button type="button" className={styles.save} onClick={onSave}>
          <Icon name="save" size={15} />
          Save
        </button>
      </div>
    </Overlay>
  )
}
