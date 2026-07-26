import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import type { Sender } from './threadRow'
import {
  TONE_CLASS,
  TONE_LABEL,
  TONE_ORDER,
  useHasToneOverride,
  useSenderTone,
  useSenderToneStore
} from './senderTones'
import styles from './EmailView.module.css'

const VIEWPORT_MARGIN = 8

export interface SenderToneTarget {
  sender: Sender
  x: number
  y: number
}

interface SenderToneMenuProps {
  target: SenderToneTarget
  onClose: () => void
}

/**
 * Right-click a row to choose that sender's colour.
 *
 * Its own menu rather than the app's shared one, which is built in the main
 * process from a list of labels — there is no way to put five swatches in it,
 * and a colour picker made of the words "Cyan", "Azure" and so on would be a
 * worse way to pick a colour than looking at it.
 */
export function SenderToneMenu({ target, onClose }: SenderToneMenuProps): JSX.Element {
  const setTone = useSenderToneStore((state) => state.setTone)
  const clearTone = useSenderToneStore((state) => state.clearTone)
  const current = useSenderTone(target.sender.address)
  const overridden = useHasToneOverride(target.sender.address)

  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    // Capture phase: the list this was opened from scrolls, and a menu left
    // behind at fixed coordinates would point at a different row.
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  // Measured first, then placed, so a right-click near the bottom of the
  // window doesn't open a menu that runs off it.
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({
      x: Math.min(
        Math.max(target.x, VIEWPORT_MARGIN),
        window.innerWidth - rect.width - VIEWPORT_MARGIN
      ),
      y: Math.min(
        Math.max(target.y, VIEWPORT_MARGIN),
        window.innerHeight - rect.height - VIEWPORT_MARGIN
      )
    })
  }, [target])

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={styles.toneMenu}
      style={{
        left: position?.x ?? target.x,
        top: position?.y ?? target.y,
        visibility: position ? 'visible' : 'hidden'
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className={styles.toneMenuHead}>
        <strong>{target.sender.name}</strong>
        {target.sender.name !== target.sender.address && <small>{target.sender.address}</small>}
      </div>

      <div className={styles.toneSwatches}>
        {TONE_ORDER.map((tone) => (
          <button
            key={tone}
            type="button"
            role="menuitemradio"
            aria-checked={tone === current}
            aria-label={TONE_LABEL[tone]}
            title={TONE_LABEL[tone]}
            className={`${styles.toneSwatch} ${TONE_CLASS[tone]} ${
              tone === current ? styles.toneSwatchOn : ''
            }`}
            onClick={() => {
              setTone(target.sender.address, tone)
              onClose()
            }}
          >
            {tone === current && <Icon name="check" size={13} />}
          </button>
        ))}
      </div>

      <button
        type="button"
        role="menuitem"
        className={styles.toneMenuItem}
        disabled={!overridden}
        onClick={() => {
          clearTone(target.sender.address)
          onClose()
        }}
      >
        <Icon name="refresh" size={13} />
        Back to automatic
      </button>

      {/* Says what the colour is for, because it is the question the colour
          itself raises: it identifies a sender and means nothing else. */}
      <p className={styles.toneMenuNote}>
        Applies to everything from {target.sender.address.split('@').pop() ?? 'this sender'}.
      </p>
    </div>,
    document.body
  )
}
