import styles from './Spinner.module.css'

interface SpinnerProps {
  size?: number
  /** Stroke width of the ring. */
  thickness?: number
  /**
   * `ring` is the everyday comet loader; `hex` laps the Anodex hexagon and is
   * reserved for brand moments (model loading, engine start, app boot).
   */
  variant?: 'ring' | 'hex'
  className?: string
}

const HEX_PATH = 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3z'

/** Indeterminate loader, coloured by the surrounding text colour. */
export function Spinner({
  size = 16,
  thickness = 2,
  variant = 'ring',
  className
}: SpinnerProps): JSX.Element {
  if (variant === 'hex') {
    return (
      <svg
        className={[styles.hex, className].filter(Boolean).join(' ')}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d={HEX_PATH}
          stroke="currentColor"
          strokeOpacity="0.15"
          strokeWidth={thickness}
          strokeLinejoin="round"
        />
        <path
          className={styles.hexRunner}
          d={HEX_PATH}
          stroke="currentColor"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={100}
          strokeDasharray="26 74"
        />
      </svg>
    )
  }
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
        strokeOpacity="0.15"
        strokeWidth={thickness}
      />
      <circle
        className={styles.arc}
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth={thickness}
        strokeLinecap="round"
        pathLength={100}
      />
    </svg>
  )
}
