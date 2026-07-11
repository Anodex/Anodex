import { describe, expect, it } from 'vitest'
import { buildKickoffPrompt, CONTINUE_PROMPT } from '../agentPrompts'

describe('buildKickoffPrompt', () => {
  it('includes the goal verbatim', () => {
    const prompt = buildKickoffPrompt('Summarize CONTRIBUTING.md')
    expect(prompt).toContain('Goal: Summarize CONTRIBUTING.md')
  })

  it('mentions find_skill and finish_goal', () => {
    const prompt = buildKickoffPrompt('Do the thing')
    expect(prompt).toContain('find_skill')
    expect(prompt).toContain('finish_goal')
  })
})

describe('CONTINUE_PROMPT', () => {
  it('mentions finish_goal', () => {
    expect(CONTINUE_PROMPT).toContain('finish_goal')
  })

  it('does not restate a specific goal (goal-agnostic, reused every turn)', () => {
    expect(CONTINUE_PROMPT).not.toContain('Goal:')
  })
})
