import { useUiStore } from '../stores/uiStore'
import { Icon, type IconName } from './Icon'
import { Spinner } from './ui/Spinner'
import type { ToastKind } from '../stores/uiStore'
import styles from './Toasts.module.css'

const ICON_BY_KIND: Record<Exclude<ToastKind, 'pending'>, IconName> = {
  info: 'info',
  success: 'check',
  error: 'alert'
}

/** Fixed-position stack of transient notifications. */
export function Toasts(): JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)

  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.kind]}`}>
          <span className={styles.icon}>
            {toast.kind === 'pending' ? (
              <Spinner size={14} />
            ) : (
              <Icon name={ICON_BY_KIND[toast.kind]} size={16} />
            )}
          </span>
          <div className={styles.body}>
            <div className={styles.title}>{toast.title}</div>
            {toast.message && <div className={styles.message}>{toast.message}</div>}
          </div>
          <button
            className={styles.close}
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
