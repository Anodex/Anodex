import { describe, expect, it } from 'vitest'
import { buildKickoffPrompt } from '../agentPrompts'

/**
 * What a run is told when it has done this before.
 *
 * The failure this prevents is subtle and total: given the same goal text
 * twice, a run with no memory reads it as new work and starts over. For an
 * ongoing goal — grow this portfolio, keep this thing up to date — starting
 * over is not a partial failure, it undoes the reason for running it again.
 */
describe('buildKickoffPrompt', () => {
  const GOAL = 'Grow a $50 paper portfolio and track every pick'

  it('says nothing about history on a first run', () => {
    const prompt = buildKickoffPrompt(GOAL)
    expect(prompt).toContain(GOAL)
    expect(prompt).not.toMatch(/journal/i)
    expect(prompt).not.toMatch(/worked on this goal before/i)
  })

  it('treats an empty journal as no journal', () => {
    // A series whose first run wrote nothing must not be told it has history
    // and then handed an empty section to reason about.
    for (const empty of [null, undefined, '', '   \n  ']) {
      const prompt = buildKickoffPrompt(GOAL, empty)
      expect(prompt).not.toMatch(/journal/i)
    }
  })

  it('tells a continuing run it is continuing, not starting', () => {
    const prompt = buildKickoffPrompt(GOAL, '## run 1\nBought 1 share of X.')
    expect(prompt).toMatch(/worked on this goal before/i)
    expect(prompt).toMatch(/continue from where it leaves off/i)
    expect(prompt).toMatch(/rather than starting again/i)
  })

  it('carries the journal itself, delimited so it cannot bleed into the goal', () => {
    const prompt = buildKickoffPrompt(GOAL, '## run 1\nBought 1 share of X at $20.')
    expect(prompt).toContain('--- JOURNAL ---')
    expect(prompt).toContain('--- END JOURNAL ---')
    expect(prompt).toContain('Bought 1 share of X at $20.')
    // The goal still arrives last, after the history, so it reads as the
    // instruction rather than as one more journal line.
    expect(prompt.lastIndexOf(GOAL)).toBeGreaterThan(prompt.indexOf('--- END JOURNAL ---'))
  })

  it('says the files outrank the journal when they disagree', () => {
    // The journal is what the run *said* it did; the files are what exists.
    // Those come apart — a run that claimed a write that failed is exactly
    // the case — and the model needs to know which to believe.
    const prompt = buildKickoffPrompt(GOAL, 'Bought 1 share.')
    expect(prompt).toMatch(/check the files/i)
    expect(prompt).toMatch(/the files are what\s+actually exists/i)
  })

  it('still asks for finish_goal, which is how any run ends', () => {
    expect(buildKickoffPrompt(GOAL, 'history')).toContain('finish_goal')
    expect(buildKickoffPrompt(GOAL)).toContain('finish_goal')
  })
})
