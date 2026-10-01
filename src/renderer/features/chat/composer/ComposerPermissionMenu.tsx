import { useEffect, useRef, useState } from 'react'
import type { PermissionMode } from '@shared/settings.types'
import { Icon } from '../../../components/Icon'
import {
  PERMISSION_ACTIVE_CLASS,
  PERMISSION_MODES,
  permissionDescription,
  permissionIcon,
  permissionLabel
} from './permissionModes'
import styles from '../ChatComposer.module.css'

interface ComposerPermissionMenuProps {
  mode: PermissionMode
  onSelect: (mode: PermissionMode) => void
}

/** Composer-local permission mode selector with click-away dismissal. */
export function ComposerPermissionMenu({
  mode,
  onSelect
}: ComposerPermissionMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(event: MouseEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const selectMode = (nextMode: PermissionMode): void => {
    onSelect(nextMode)
    setOpen(false)
  }

  return (
    <div className={styles.permMenu} ref={menuRef}>
      <button
        type="button"
        className={`${styles.permTrigger} ${styles[PERMISSION_ACTIVE_CLASS[mode]]}`}
        onClick={() => setOpen((value) => !value)}
        title={`Permission mode: ${permissionLabel(mode)} — ${permissionDescription(mode)}`}
        aria-label={`Permission mode: ${permissionLabel(mode)}`}
        data-tour="permissions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name={permissionIcon(mode)} size={14} />
      </button>

      {open && (
        <div className={styles.permDropdown} role="menu" aria-label="Permission mode">
          {PERMISSION_MODES.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={mode === option}
              className={styles.permItem}
              onClick={() => selectMode(option)}
            >
              <Icon
                name={permissionIcon(option)}
                size={14}
                className={styles[`permItemIcon${permissionLabel(option)}`]}
              />
              <span className={styles.permItemText}>
                <span className={styles.permItemLabel}>{permissionLabel(option)}</span>
                <span className={styles.permItemDesc}>{permissionDescription(option)}</span>
              </span>
              {mode === option && <Icon name="check" size={13} className={styles.permItemCheck} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
