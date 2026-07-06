import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './Spinner'
import styles from './Button.module.css'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  iconLeft?: ReactNode
  loading?: boolean
}

/** Primary action button with brand variants and a built-in loading state. */
export function Button({
  variant = 'secondary',
  size = 'md',
  iconLeft,
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [styles.button, styles[variant], styles[size], className]
    .filter(Boolean)
    .join(' ')

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} /> : iconLeft}
      {children && <span>{children}</span>}
    </button>
  )
}
