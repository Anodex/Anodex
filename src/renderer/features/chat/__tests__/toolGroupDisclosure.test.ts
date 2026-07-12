import { describe, expect, it } from 'vitest'
import { shouldStartToolGroupExpanded } from '../toolGroupDisclosure'

describe('shouldStartToolGroupExpanded', () => {
  it('starts small tool groups expanded so recent work stays visible', () => {
    expect(shouldStartToolGroupExpanded(2)).toBe(true)
  })

  it('starts large tool groups collapsed so long turns stay scannable', () => {
    expect(shouldStartToolGroupExpanded(7)).toBe(false)
  })

  it('uses a configurable threshold', () => {
    expect(shouldStartToolGroupExpanded(4, 3)).toBe(false)
    expect(shouldStartToolGroupExpanded(3, 3)).toBe(true)
  })
})
