import { describe, expect, it } from 'vitest'
import type { Plan } from '../plan.types'
import { acceptEditedPlan, planTitlesChanged } from '../planEdit'

const proposed: Plan = {
  title: 'Sort photos',
  updatedAt: 0,
  steps: [
    { id: 'a', title: 'List the photos', status: 'pending' },
    { id: 'b', title: 'Move them', status: 'pending' }
  ]
}

describe('acceptEditedPlan', () => {
  it('takes edited titles, trimmed, with every step pending', () => {
    const plan = acceptEditedPlan(
      {
        steps: [
          { id: 'a', title: '  List the photos and their dates ', status: 'completed' },
          { title: 'Report anything without a date' }
        ]
      },
      proposed
    )
    expect(plan?.title).toBe('Sort photos')
    expect(plan?.steps.map((step) => [step.title, step.status])).toEqual([
      ['List the photos and their dates', 'pending'],
      ['Report anything without a date', 'pending']
    ])
    expect(plan?.steps[0].id).toBe('a')
    expect(plan?.steps[1].id).toBeTruthy()
  })

  it.each([
    ['nothing', undefined],
    ['no steps', { steps: [] }],
    ['an empty title', { steps: [{ title: '   ' }] }],
    ['a title that is not text', { steps: [{ title: 4 }] }],
    ['too many steps', { steps: Array.from({ length: 31 }, () => ({ title: 'x' })) }],
    ['a title too long to be a step', { steps: [{ title: 'x'.repeat(301) }] }]
  ])('refuses %s, so the run keeps its own plan', (_label, value) => {
    expect(acceptEditedPlan(value, proposed)).toBeNull()
  })
})

describe('planTitlesChanged', () => {
  it('notices a changed, added or removed step, and nothing else', () => {
    expect(planTitlesChanged(proposed, { ...proposed, updatedAt: 5 })).toBe(false)
    expect(
      planTitlesChanged(proposed, {
        ...proposed,
        steps: [proposed.steps[0], { ...proposed.steps[1], title: 'Move each one' }]
      })
    ).toBe(true)
    expect(planTitlesChanged(proposed, { ...proposed, steps: [proposed.steps[0]] })).toBe(true)
  })
})
