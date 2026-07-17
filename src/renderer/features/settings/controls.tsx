import type { CSSProperties } from 'react'
import styles from './controls.module.css'

interface RangeControlProps {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
}

/** A labelled range slider with a gradient-filled track and live value. */
export function RangeControl({
  value,
  min,
  max,
  step,
  onChange,
  format
}: RangeControlProps): JSX.Element {
  const percent = ((value - min) / (max - min)) * 100
  return (
    <div className={styles.range}>
      <input
        type="range"
        className={styles.slider}
        style={{ '--fill': `${percent}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className={styles.value}>{format ? format(value) : value}</span>
    </div>
  )
}

interface Option {
  label: string
  value: string
}

interface SelectControlProps {
  value: string
  options: Option[]
  onChange: (value: string) => void
}

/** A styled native select. */
export function SelectControl({ value, options, onChange }: SelectControlProps): JSX.Element {
  return (
    <select
      className={styles.select}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

interface ToggleControlProps {
  checked: boolean
  onChange: (checked: boolean) => void
  ariaLabel?: string
}

/** An on/off switch. */
export function ToggleControl({ checked, onChange, ariaLabel }: ToggleControlProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`${styles.toggle} ${checked ? styles.toggleOn : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} />
    </button>
  )
}

interface TextControlProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'password'
}

/** A styled text input. */
export function TextControl({
  value,
  onChange,
  placeholder,
  type = 'text'
}: TextControlProps): JSX.Element {
  return (
    <input
      type={type}
      className={styles.text}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}
