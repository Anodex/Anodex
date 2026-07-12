import { describe, expect, it } from 'vitest'
import { shouldStartToolGroupExpanded } from '../toolGroupDisclosure'

describe('shouldStartToolGroupExpanded', () => {
  it('starts small tool groups collapsed to keep the transcript compact by default', () => {
    expect(shouldStartToolGroupExpanded(2)).toBe(false)
  })

  it('starts large tool groups collapsed so long turns stay scannable', () => {
    expect(shouldStartToolGroupExpanded(7)).toBe(false)
  })

  it('ignores legacy threshold callers and still defaults collapsed', () => {
    expect(shouldStartToolGroupExpanded(4, 3)).toBe(false)
    expect(shouldStartToolGroupExpanded(3, 3)).toBe(false)
  })
})
