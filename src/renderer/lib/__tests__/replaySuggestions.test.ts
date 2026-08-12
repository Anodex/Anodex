import { describe, expect, it } from 'vitest'
import { suggestionFromPlan } from '../replaySuggestions'

describe('suggestionFromPlan', () => {
  it('uses the first unfinished visible plan step', () => {
    expect(
      suggestionFromPlan({
        title: 'Build the feature',
        updatedAt: 1,
        steps: [
          { id: 'one', title: 'Phase 1: Foundations', status: 'completed' },
          { id: 'two', title: 'Phase 2: Composer replay', status: 'in_progress' },
          { id: 'three', title: 'Phase 3: Verification', status: 'pending' }
        ]
      })
    ).toBe('Start working on Phase 2: Composer replay.')
  })

  it('numbers ordinary step titles and never returns a completed step', () => {
    expect(
      suggestionFromPlan({
        title: 'Build the feature',
        updatedAt: 1,
        steps: [
          { id: 'one', title: 'Inspect the workspace', status: 'completed' },
          { id: 'two', title: 'Implement the composer', status: 'pending' }
        ]
      })
    ).toBe('Start working on step 2: Implement the composer.')
  })

  it('stays quiet after every plan step is complete', () => {
    expect(
      suggestionFromPlan({
        title: 'Done',
        updatedAt: 1,
        steps: [{ id: 'one', title: 'Ship it', status: 'completed' }]
      })
    ).toBeNull()
  })
})
