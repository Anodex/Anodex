import { Overlay } from './Overlay'
import { Icon, type IconName } from '../Icon'
import styles from './ConfirmDialog.module.css'

interface ConfirmDialogProps {
  title: string
  message?: string
  /** Optional monospace detail box below the message, e.g. the item's name/text. */
  detail?: string
  confirmLabel: string
  icon?: IconName
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Generic blocking confirmation dialog for destructive actions, so callers
 * don't fall back to a plain `window.confirm()` (unstyled, breaks the app's
 * dark theme). Extracted from `DeleteConfirmDialog` — that one is specific to
 * file/folder deletion ("moves to Recycle Bin" wording); this one takes plain
 * title/message/confirmLabel props for any destructive confirmation. Uses the
 * shared `Overlay` chrome (backdrop, card, Escape-to-close).
 */
export function ConfirmDialog({
  title,
  message,
  detail,
  confirmLabel,
  icon = 'trash',
  onCancel,
  onConfirm
}: ConfirmDialogProps): JSX.Element {
  return (
    <Overlay onClose={onCancel} ariaLabel={title} cardClassName={styles.modal}>
      <div className={styles.header}>
        <span className={styles.badge}>
          <Icon name={icon} size={16} />
        </span>
        <div>
          <div className={styles.title}>{title}</div>
          {message && <div className={styles.subtitle}>{message}</div>}
        </div>
      </div>

      {detail && <div className={styles.detail}>{detail}</div>}

      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={styles.confirm} onClick={onConfirm}>
          <Icon name={icon} size={15} />
          {confirmLabel}
        </button>
      </div>
    </Overlay>
  )
}
