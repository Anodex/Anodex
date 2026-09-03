import { useEffect, useRef, useState } from 'react'
import type { ChatPersonality } from '@shared/chatPersonality'
import { Icon } from '../../../../components/Icon'
import { PersonalityAvatar } from '../../../../components/ui/PersonalityAvatar'
import { personalityDisplayName } from '../../../../components/ui/personalityIdentity'
import styles from './PersonalitySection.module.css'

/**
 * Choosing which character is active.
 *
 * Deliberately not a `SelectControl`. A native `<select>` cannot render an
 * image, so the picture would disappear at exactly the moment you are choosing
 * between faces — and the picture is the point of the redesign.
 *
 * Choosing lives in a dropdown rather than a grid of cards because the list is
 * unbounded in practice (fifty saved plus seven built-in) while the card above
 * it is one, fixed thing. A grid would grow the screen with the list; this does
 * not.
 */
export function PersonalityPicker({
  builtIns,
  saved,
  activeId,
  atLimit,
  onSelect,
  onCreate
}: {
  builtIns: readonly ChatPersonality[]
  saved: readonly ChatPersonality[]
  activeId: string | null
  atLimit: boolean
  onSelect: (id: string) => void
  onCreate: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const active = [...builtIns, ...saved].find((item) => item.id === activeId) ?? builtIns[0]

  useEffect(() => {
    if (!open) return undefined
    function onPointerDown(event: MouseEvent): void {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  /** Arrow keys move between options and wrap; Escape closes and returns focus. */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      setOpen(false)
      ref.current?.querySelector<HTMLButtonElement>(`.${styles.pickerTrigger}`)?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
    )
    if (options.length === 0) return
    const at = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1
    options[(next + options.length) % options.length]?.focus()
  }

  function renderGroup(label: string, items: readonly ChatPersonality[]): JSX.Element | null {
    if (items.length === 0) return null
    return (
      <>
        <div className={styles.listGroup}>
          {label} · {items.length}
        </div>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={item.id === activeId}
            className={styles.option}
            onClick={() => {
              onSelect(item.id)
              setOpen(false)
            }}
          >
            <PersonalityAvatar personality={item} size={26} />
            <span className={styles.optionName}>{personalityDisplayName(item)}</span>
            <span className={styles.optionRole}>{item.role ?? ''}</span>
            {item.id === activeId && <Icon name="check" size={13} className={styles.optionTick} />}
          </button>
        ))}
      </>
    )
  }

  return (
    <div className={styles.picker} ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={styles.pickerTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PersonalityAvatar personality={active} size={26} />
        <span className={styles.pickerName}>{personalityDisplayName(active)}</span>
        <Icon name="chevron-down" size={12} className={styles.pickerChevron} />
      </button>

      {open && (
        <div className={styles.popover}>
          <div
            className={styles.listbox}
            role="listbox"
            aria-label="Choose a personality"
            ref={listRef}
          >
            {renderGroup('Built in', builtIns)}
            {renderGroup('Yours', saved)}
          </div>
          {/* Outside the listbox on purpose: creating is a command, not one of
              the things being chosen between. */}
          <div className={styles.popoverFoot}>
            <button
              type="button"
              className={styles.newButton}
              disabled={atLimit}
              title={atLimit ? 'Delete one to add another' : undefined}
              onClick={() => {
                onCreate()
                setOpen(false)
              }}
            >
              <span className={styles.newPlus} aria-hidden="true">
                +
              </span>
              <span>New personality</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
