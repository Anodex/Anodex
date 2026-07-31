import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import type { Sender } from './threadRow'
import { customAvatarStyle, legibleHex } from './customTone'
import {
  isCustomColor,
  TONE_CLASS,
  TONE_LABEL,
  TONE_ORDER,
  useHasToneOverride,
  useSenderColor,
  useSenderToneStore,
  type SenderCustomColor
} from './senderTones'
import styles from './EmailView.module.css'

const VIEWPORT_MARGIN = 8
const SUGGESTED_CUSTOM = '#4f8cff'

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
  const current = useSenderColor(target.sender.address)
  const custom = isCustomColor(current)
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

        {/* The OS colour picker, wearing the swatch's clothes. A native input
            rather than a colour wheel of our own: it is the picker the reader
            already knows, it remembers their recent colours, and it is one
            element instead of a component to maintain. */}
        <label
          className={`${styles.toneSwatch} ${styles.toneSwatchCustom} ${
            custom ? styles.toneSwatchOn : ''
          }`}
          style={custom ? customAvatarStyle(current) : undefined}
          title="Custom colour…"
        >
          <input
            type="color"
            className={styles.toneColorInput}
            aria-label="Custom colour"
            value={custom ? current : (legibleHex(SUGGESTED_CUSTOM) ?? SUGGESTED_CUSTOM)}
            // `onChange` rather than `onInput`'s equivalent commit-only event:
            // dragging around the OS picker repaints the whole inbox live, so
            // the choice is judged where it will actually be seen.
            onChange={(event) =>
              setTone(target.sender.address, event.target.value as SenderCustomColor)
            }
          />
          {custom ? <Icon name="check" size={13} /> : <Icon name="palette" size={14} />}
        </label>
      </div>

      {custom && (
        <p className={styles.toneCustomValue}>
          {current}
          {legibleHex(current) !== current && (
            // Said plainly rather than silently corrected, or the reader picks
            // a colour, sees a different one, and assumes the picker is broken.
            <span className={styles.toneAdjusted}> · lightened to stay readable</span>
          )}
        </p>
      )}

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
