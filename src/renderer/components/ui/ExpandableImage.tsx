import { useCallback, useRef, useState } from 'react'
import { Icon } from '../Icon'
import { ImageLightbox } from './ImageLightbox'
import styles from './ExpandableImage.module.css'

interface ExpandableImageProps {
  src: string
  alt: string
  title: string
  imageClassName?: string
  triggerClassName?: string
}

export function ExpandableImage({
  src,
  alt,
  title,
  imageClassName,
  triggerClassName
}: ExpandableImageProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const close = useCallback(() => {
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${triggerClassName ?? ''}`}
        onClick={() => setOpen(true)}
        aria-label={`Open ${title} fullscreen`}
        title="Open image fullscreen"
      >
        <img className={imageClassName} src={src} alt={alt} />
        <span className={styles.expandHint} aria-hidden="true">
          <Icon name="maximize" size={15} />
        </span>
      </button>
      {open && <ImageLightbox src={src} alt={alt} title={title} onClose={close} />}
    </>
  )
}
