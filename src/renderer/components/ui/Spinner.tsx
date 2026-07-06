import styles from './Spinner.module.css'

interface SpinnerProps {
  size?: number
  /** Stroke width of the ring. */
  thickness?: number
  className?: string
}

/** Indeterminate loading ring, coloured by the surrounding text colour. */
export function Spinner({ size = 16, thickness = 2, className }: SpinnerProps): JSX.Element {
  return (
    <svg
      className={[styles.spinner, className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth={thickness}
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth={thickness}
        strokeLinecap="round"
      />
    </svg>
  )
}
