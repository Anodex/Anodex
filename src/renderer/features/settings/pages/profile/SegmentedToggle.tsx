import styles from './SegmentedToggle.module.css'

interface SegmentedToggleOption<T extends string> {
  label: string
  value: T
}

interface SegmentedToggleProps<T extends string> {
  value: T
  options: SegmentedToggleOption<T>[]
  onChange: (value: T) => void
}

/** Small button-group control — shared by the time-range filter and the chart granularity toggle. */
export function SegmentedToggle<T extends string>({
  value,
  options,
  onChange
}: SegmentedToggleProps<T>): JSX.Element {
  return (
    <div className={styles.group} role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.segment}
          data-active={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
