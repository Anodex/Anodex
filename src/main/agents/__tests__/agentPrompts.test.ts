import { describe, expect, it } from 'vitest'
import {
  buildKickoffPrompt,
  buildPlanningPrompt,
  CONTINUE_PROMPT,
  PLAN_APPROVED_PROMPT,
  PLAN_RETRY_PROMPT
} from '../agentPrompts'

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

describe('buildPlanningPrompt', () => {
  it('includes the goal verbatim', () => {
    const prompt = buildPlanningPrompt('Summarize CONTRIBUTING.md')
    expect(prompt).toContain('Goal: Summarize CONTRIBUTING.md')
  })

  it('mentions write_plan and not finish_goal', () => {
    const prompt = buildPlanningPrompt('Do the thing')
    expect(prompt).toContain('write_plan')
    expect(prompt).not.toContain('finish_goal')
  })
})

describe('PLAN_APPROVED_PROMPT', () => {
  it('mentions update_plan_step', () => {
    expect(PLAN_APPROVED_PROMPT).toContain('update_plan_step')
  })
})

describe('PLAN_RETRY_PROMPT', () => {
  it('mentions write_plan', () => {
    expect(PLAN_RETRY_PROMPT).toContain('write_plan')
  })
})
