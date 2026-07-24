import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon'
import { changeImageZoom } from './imageLightboxZoom'
import styles from './ImageLightbox.module.css'

interface ImageLightboxProps {
  src: string
  alt: string
  title: string
  onClose: () => void
}

export function ImageLightbox({ src, alt, title, onClose }: ImageLightboxProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.requestAnimationFrame(() => closeRef.current?.focus())

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        setZoom((current) => changeImageZoom(current, 1))
        return
      }
      if (event.key === '-') {
        event.preventDefault()
        setZoom((current) => changeImageZoom(current, -1))
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        setZoom(1)
        return
      }
      if (event.key !== 'Tab') return

      const focusable =
        dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  return createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Fullscreen image: ${title}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <span className={styles.title} title={title}>
            {title}
          </span>
          <div className={styles.controls}>
            <button
              type="button"
              className={styles.control}
              onClick={() => setZoom((current) => changeImageZoom(current, -1))}
              disabled={zoom === 0.5}
              aria-label="Zoom out"
              title="Zoom out (-)"
            >
              <Icon name="minimize" size={16} />
            </button>
            <button
              type="button"
              className={styles.zoomValue}
              onClick={() => setZoom(1)}
              aria-label={`Reset zoom, currently ${Math.round(zoom * 100)}%`}
              title="Reset zoom (0)"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className={styles.control}
              onClick={() => setZoom((current) => changeImageZoom(current, 1))}
              disabled={zoom === 3}
              aria-label="Zoom in"
              title="Zoom in (+)"
            >
              <Icon name="plus" size={16} />
            </button>
            <span className={styles.divider} aria-hidden="true" />
            <button
              ref={closeRef}
              type="button"
              className={styles.control}
              onClick={onClose}
              aria-label="Close fullscreen image"
              title="Close (Esc)"
            >
              <Icon name="close" size={17} />
            </button>
          </div>
        </header>
        <div className={styles.canvas}>
          <img
            className={styles.image}
            src={src}
            alt={alt}
            style={{ transform: `scale(${zoom})` }}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}
