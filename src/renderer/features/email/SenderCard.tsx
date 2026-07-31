import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import type { Sender } from './threadRow'
import styles from './EmailView.module.css'

const VIEWPORT_MARGIN = 8

/**
 * How long the card survives the pointer leaving it.
 *
 * The whole point of this card is that the address in it can be selected and
 * copied, which means the pointer has to be able to travel from the name to
 * the card without it closing on the way. A native `title` tooltip — which is
 * what this replaces — vanishes the moment you move towards it.
 */
const GRACE_MS = 160

interface SenderCardProps {
  sender: Sender
  /** What the trigger reads, which is "You" for the account's own messages. */
  label: string
  to: string[]
  cc: string[]
  triggerClassName: string
}

export function SenderCard({
  sender,
  label,
  to,
  cc,
  triggerClassName
}: SenderCardProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number>()

  const show = (): void => {
    window.clearTimeout(closeTimer.current)
    setOpen(true)
  }

  const hide = (): void => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), GRACE_MS)
  }

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const close = (): void => setOpen(false)
    document.addEventListener('keydown', handleKey)
    // Capture phase: the reader scrolls under the card, and one left behind at
    // fixed coordinates would be pointing at a different message.
    document.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open])

  // Measured before it is placed, so a name near the bottom of the window does
  // not open a card that runs off it.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const trigger = triggerRef.current?.getBoundingClientRect()
    const card = cardRef.current?.getBoundingClientRect()
    if (!trigger || !card) return

    const below = trigger.bottom + 6
    const fitsBelow = below + card.height <= window.innerHeight - VIEWPORT_MARGIN
    setPosition({
      x: Math.min(
        Math.max(trigger.left, VIEWPORT_MARGIN),
        window.innerWidth - card.width - VIEWPORT_MARGIN
      ),
      y: fitsBelow ? below : Math.max(VIEWPORT_MARGIN, trigger.top - card.height - 6)
    })
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-expanded={open}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={show}
      >
        {label}
      </button>

      {open &&
        createPortal(
          <div
            ref={cardRef}
            className={styles.senderCard}
            style={{
              left: position?.x ?? 0,
              top: position?.y ?? 0,
              visibility: position ? 'visible' : 'hidden'
            }}
            onPointerEnter={show}
            onPointerLeave={hide}
            // React's focus events bubble through the portal, so focus landing
            // on the copy button keeps the card up rather than dismissing the
            // thing the focus is inside.
            onFocus={show}
            onBlur={hide}
          >
            <div className={styles.senderCardName}>{sender.name}</div>
            <CopyableRow value={sender.address} />
            {to.length > 0 && <RecipientRow label="To" values={to} />}
            {cc.length > 0 && <RecipientRow label="Cc" values={cc} />}
          </div>,
          document.body
        )}
    </>
  )
}

/** An address that can be selected with the mouse, or taken in one click. */
function CopyableRow({ value }: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* Clipboard unavailable — the text is still selectable by hand. */
    }
  }

  return (
    <div className={styles.senderCardRow}>
      <span className={styles.senderCardValue}>{value}</span>
      <button
        type="button"
        className={styles.senderCardCopy}
        title={copied ? 'Copied' : `Copy ${value}`}
        aria-label={copied ? 'Copied' : `Copy ${value}`}
        onClick={() => void copy()}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </div>
  )
}

function RecipientRow({ label, values }: { label: string; values: string[] }): JSX.Element {
  return (
    <div className={styles.senderCardRecipients}>
      <span className={styles.senderCardLabel}>{label}</span>
      <span className={styles.senderCardValue}>{values.join(', ')}</span>
    </div>
  )
}
