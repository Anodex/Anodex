import { useEffect, useRef, useState } from 'react'
import { Overlay } from './Overlay'
import { Icon, type IconName } from '../Icon'
import styles from './TextPromptDialog.module.css'

interface TextPromptDialogProps {
  title: string
  label: string
  initialValue: string
  confirmLabel: string
  icon?: IconName
  onCancel: () => void
  onConfirm: (value: string) => void
}

export function TextPromptDialog({
  title,
  label,
  initialValue,
  confirmLabel,
  icon = 'folder',
  onCancel,
  onConfirm
}: TextPromptDialogProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const trimmed = value.trim()

  return (
    <Overlay onClose={onCancel} ariaLabel={title} cardClassName={styles.modal}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmed) onConfirm(trimmed)
        }}
      >
        <div className={styles.header}>
          <span className={styles.badge}>
            <Icon name={icon} size={16} />
          </span>
          <div>
            <div className={styles.title}>{title}</div>
            <label className={styles.label} htmlFor="text-prompt-input">
              {label}
            </label>
          </div>
        </div>

        <div className={styles.body}>
          <input
            ref={inputRef}
            id="text-prompt-input"
            className={styles.input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={styles.confirm} disabled={!trimmed}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Overlay>
  )
}
