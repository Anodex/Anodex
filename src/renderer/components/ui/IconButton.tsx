import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './IconButton.module.css'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label — required since the button has no visible text. */
  label: string
  icon: ReactNode
  size?: 'sm' | 'md'
}

/** Square, icon-only button for toolbar and inline actions. */
export function IconButton({
  label,
  icon,
  size = 'md',
  className,
  ...rest
}: IconButtonProps): JSX.Element {
  const classes = [styles.iconButton, styles[size], className].filter(Boolean).join(' ')
  return (
    <button className={classes} aria-label={label} title={label} {...rest}>
      {icon}
    </button>
  )
}
