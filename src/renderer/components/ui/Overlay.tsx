import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './Overlay.module.css'

interface OverlayProps {
  onClose: () => void
  ariaLabel: string
  children: ReactNode
  /**
   * Composes onto the shared `.card`/`.overlay` classes (see
   * `Overlay.module.css`) for call-site-specific sizing — the one thing that
   * legitimately differs between a full settings panel and a small
   * confirmation dialog. Everything else (background, border, radius,
   * shadow, animation) is shared.
   */
  cardClassName?: string
  overlayClassName?: string
}

/**
 * Shared chrome for Tier 1 blocking overlays (Settings, delete confirmation):
 * backdrop, centered card, Escape-to-close, click-outside-to-close. Portals to
 * `document.body` so it renders correctly regardless of where in the tree
 * it's mounted from (a scrolling panel, a nested dialog, etc.).
 */
export function Overlay({
  onClose,
  ariaLabel,
  children,
  cardClassName,
  overlayClassName
}: OverlayProps): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className={`${styles.overlay} ${overlayClassName ?? ''}`} onClick={onClose}>
      <div
        className={`${styles.card} ${cardClassName ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
