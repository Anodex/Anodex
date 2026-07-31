import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon'
import { copyImageToClipboard, saveImageDownload } from './imageActions'
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
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  // Degrees clockwise, always normalized to 0/90/180/270. View-only: rotating
  // never rewrites the bytes, so copy and save still hand over the original.
  const [rotation, setRotation] = useState(0)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [panning, setPanning] = useState(false)
  const rotate = (degrees: number): void =>
    setRotation((current) => (current + degrees + 360) % 360)

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
        setRotation(0)
        return
      }
      if (event.key === '[' || event.key === ']') {
        event.preventDefault()
        setRotation((current) => (current + (event.key === '[' ? -90 : 90) + 360) % 360)
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

  const handleCopy = async (): Promise<void> => {
    try {
      await copyImageToClipboard(src)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
    window.setTimeout(() => setCopyStatus('idle'), 1600)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (zoom <= 1 || event.button !== 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: canvas.scrollLeft,
      top: canvas.scrollTop
    }
    canvas.setPointerCapture(event.pointerId)
    setPanning(true)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragRef.current
    const canvas = canvasRef.current
    if (!start || !canvas) return
    canvas.scrollLeft = start.left - (event.clientX - start.x)
    canvas.scrollTop = start.top - (event.clientY - start.y)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    setPanning(false)
  }

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
              type="button"
              className={styles.control}
              onClick={() => rotate(-90)}
              aria-label="Rotate left"
              title="Rotate left ([)"
            >
              <Icon name="rotate-ccw" size={16} />
            </button>
            <button
              type="button"
              className={styles.control}
              onClick={() => rotate(90)}
              aria-label="Rotate right"
              title="Rotate right (])"
            >
              <Icon name="rotate-cw" size={16} />
            </button>
            <span className={styles.divider} aria-hidden="true" />
            <button
              type="button"
              className={styles.control}
              onClick={() => void handleCopy()}
              aria-label="Copy image"
              title="Copy image"
            >
              <Icon name={copyStatus === 'copied' ? 'check' : 'copy'} size={16} />
            </button>
            <button
              type="button"
              className={styles.control}
              onClick={() => saveImageDownload(src, title)}
              aria-label="Save image"
              title="Save image"
            >
              <Icon name="download" size={16} />
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
        <div
          ref={canvasRef}
          className={`${styles.canvas} ${zoom > 1 ? styles.pannable : ''} ${
            panning ? styles.panning : ''
          }`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <img
            className={styles.image}
            src={src}
            alt={alt}
            // Rotation is applied first so zoom keeps scaling along the axes
            // the viewer is actually looking at.
            style={{ transform: `rotate(${rotation}deg) scale(${zoom})` }}
          />
        </div>
        <span className={styles.status} role="status" aria-live="polite">
          {copyStatus === 'copied'
            ? 'Image copied'
            : copyStatus === 'failed'
              ? 'Could not copy image'
              : ''}
        </span>
      </div>
    </div>,
    document.body
  )
}
