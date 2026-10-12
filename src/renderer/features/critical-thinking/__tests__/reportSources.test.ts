import { describe, expect, it } from 'vitest'
import { citationNumbers, sameUrl } from '../reportSources'

describe('citationNumbers', () => {
  it('numbers each source as the report cites it, not as it was fetched', () => {
    const numbers = citationNumbers(
      'Productivity held [3](https://autonomy.work/iceland/) and burnout fell ' +
        '[1](https://www.nature.com/articles/x). Again [3](https://autonomy.work/iceland/).'
    )
    expect(numbers.get(sameUrl('https://autonomy.work/iceland'))).toBe(3)
    expect(numbers.get(sameUrl('https://nature.com/articles/x/'))).toBe(1)
    expect(numbers.size).toBe(2)
  })

  it('ignores links that are not numbered citations', () => {
    expect(citationNumbers('See [the pilot](https://autonomy.work/pilot).').size).toBe(0)
  })
})
