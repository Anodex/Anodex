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

/**
 * Small button-group control — the app's one segmented-toggle look, used by
 * the usage time-range filter, the chart granularity toggle, and the file
 * viewer's Preview/Code switch. The selected segment is a soft accent pill
 * (`--accent-soft`), never a solid `--accent` fill: a saturated block of
 * accent at this size reads as a primary action button rather than a
 * selection, and stands out against the surrounding chrome.
 */
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
