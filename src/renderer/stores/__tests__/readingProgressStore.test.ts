import { describe, expect, it } from 'vitest'
import { readingLabel, readingPercent } from '../readingProgressStore'

describe('readingLabel', () => {
  it('shows how far a long read has got', () => {
    expect(readingLabel({ done: 4_428, total: 9_840 })).toBe('Reading · 45%')
  })

  it('shows nothing when little is left to read, so a quick read does not flicker', () => {
    expect(readingLabel({ done: 9_000, total: 9_840 })).toBeNull()
    expect(readingLabel(undefined)).toBeNull()
  })

  it('never says 100% while still reading', () => {
    expect(readingPercent({ done: 9_999, total: 10_000 })).toBe(99)
  })
})
