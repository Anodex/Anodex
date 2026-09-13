import { describe, expect, it } from 'vitest'
import { startBlockedReason } from '../startBlockedReason'

const ready = {
  goal: 'Add a helper',
  limitsEnabled: true,
  maxTurns: 30,
  maxTokens: 300_000,
  maxDurationMinutes: 120
}

describe('startBlockedReason', () => {
  it('says nothing when the run can start', () => {
    expect(startBlockedReason(ready)).toBeNull()
  })

  it('names the goal when it is empty', () => {
    expect(startBlockedReason({ ...ready, goal: '   ' })).toMatch(/goal/i)
  })

  // The reported failure. Clearing a number input gives '', and `Number('')` is
  // 0, so the budget silently fails its `>= 1` check and the Start button goes
  // dead with nothing on screen saying why: a click does nothing, no run is
  // created, and nothing reaches the log.
  it.each([
    ['maxTurns', 'turn'],
    ['maxTokens', 'token'],
    ['maxDurationMinutes', 'time']
  ])('names %s when the field has been cleared to 0', (field, word) => {
    const reason = startBlockedReason({ ...ready, [field]: 0 })

    expect(reason).not.toBeNull()
    expect(reason?.toLowerCase()).toContain(word)
  })

  it('handles a field typed into nonsense, which reads as NaN', () => {
    expect(startBlockedReason({ ...ready, maxTurns: Number.NaN })).toMatch(/turn/i)
  })

  // With limits off the budgets are not used at all, so an empty one must not
  // block the run - only the goal can.
  it('ignores the budgets when limits are disabled', () => {
    expect(
      startBlockedReason({
        ...ready,
        limitsEnabled: false,
        maxTurns: 0,
        maxTokens: 0,
        maxDurationMinutes: 0
      })
    ).toBeNull()
  })

  it('reports every missing thing at once rather than one at a time', () => {
    const reason = startBlockedReason({ ...ready, goal: '', maxTurns: 0 })

    expect(reason?.toLowerCase()).toContain('goal')
    expect(reason?.toLowerCase()).toContain('turn')
  })
})

/**
 * Images sent to a model that cannot take them fail on the provider mid-run,
 * when nobody is watching. Refused here instead, where somebody is.
 */
describe('images the selected model cannot see', () => {
  it('blocks the start and says what to do', () => {
    const reason = startBlockedReason({ ...ready, unseeableImages: 2 })
    expect(reason).toMatch(/can.t see images/)
    expect(reason).toContain('2 images')
  })

  it('does not block when there are none', () => {
    expect(startBlockedReason({ ...ready, unseeableImages: 0 })).toBeNull()
  })

  it('reports alongside anything missing', () => {
    const reason = startBlockedReason({ ...ready, goal: '', unseeableImages: 1 })
    expect(reason).toContain('a goal')
    expect(reason).toContain('the image')
  })
})
