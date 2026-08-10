import { useEffect, useRef, useState } from 'react'
import type { ConversationContextSnapshot } from '@shared/context.types'
import { Icon } from '../../components/Icon'
import styles from './ContextHistoryMenu.module.css'

interface ContextHistoryMenuProps {
  snapshots: ConversationContextSnapshot[]
  onSelect: (snapshot: ConversationContextSnapshot) => void
}

/** A compact, transcript-linked index of the context summaries retained for this chat. */
export function ContextHistoryMenu({ snapshots, onSelect }: ContextHistoryMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const dismiss = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className={styles.menu} ref={menuRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="View context revision history"
      >
        <Icon name="compact" size={13} />
        <span>Context condensed</span>
        <span className={styles.count}>
          {snapshots.length} {snapshots.length === 1 ? 'revision' : 'revisions'}
        </span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>

      {open && (
        <div className={styles.dropdown} role="dialog" aria-label="Context revision history">
          <div className={styles.heading}>
            <div>
              <strong>Context revision history</strong>
              <span>Select a revision to view its saved summary.</span>
            </div>
          </div>
          <div className={styles.entries}>
            {[...snapshots].reverse().map((snapshot, index) => (
              <button
                key={snapshot.id}
                type="button"
                className={styles.entry}
                onClick={() => {
                  setOpen(false)
                  onSelect(snapshot)
                }}
              >
                <Icon name="compact" size={14} />
                <span className={styles.entryBody}>
                  <strong>
                    {index === 0 ? 'Current context' : `Revision ${snapshots.length - index}`}
                  </strong>
                  <span>
                    {formatRevisionTime(snapshot.createdAt)} · {formatReason(snapshot.reason)} ·{' '}
                    {snapshot.removedTurns} {snapshot.removedTurns === 1 ? 'turn' : 'turns'}
                  </span>
                </span>
                <Icon name="chevron-right" size={13} className={styles.entryChevron} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatRevisionTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function formatReason(reason: ConversationContextSnapshot['reason']): string {
  if (reason === 'manual') return 'manual'
  if (reason === 'reactive') return 'recovered'
  return 'context pressure'
}
