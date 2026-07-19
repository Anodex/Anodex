import { describe, expect, it } from 'vitest'
import type { Plan } from '@shared/plan.types'
import {
  buildCriticalThinkingPlanPrompt,
  buildCriticalThinkingStepPrompt,
  buildCriticalThinkingSynthesisPrompt
} from '../criticalThinkingPrompts'

describe('Critical Thinking prompts', () => {
  it('keeps the planning stage action-free and requires write_plan', () => {
    const prompt = buildCriticalThinkingPlanPrompt('Which option is best?')

    expect(prompt).toContain('calling write_plan')
    expect(prompt).toContain('Do not answer the question or search yet')
    expect(prompt).toContain('Which option is best?')
  })

  it('separates bounded evidence collection from citation-safe synthesis', () => {
    const plan: Plan = {
      title: 'Compare the evidence',
      steps: [
        { id: 'one', title: 'Find primary evidence', status: 'pending' },
        { id: 'two', title: 'Cross-check the findings', status: 'pending' }
      ],
      updatedAt: 1
    }
    const stepPrompt = buildCriticalThinkingStepPrompt(
      'Which option is best?',
      'Find primary evidence',
      []
    )
    const synthesisPrompt = buildCriticalThinkingSynthesisPrompt(
      'Which option is best?',
      plan,
      ['Primary evidence was collected.'],
      '[S1:P1] Exact evidence'
    )

    expect(stepPrompt).toContain('web_search')
    expect(stepPrompt).toContain('fetch_url')
    expect(stepPrompt).toContain('one bounded step')
    expect(synthesisPrompt).toContain('[[S1]]')
    expect(synthesisPrompt).toContain('Never write a raw URL')
    expect(synthesisPrompt).toContain('```chart')
    expect(synthesisPrompt).toContain('Every chart value must be traceable')
    expect(synthesisPrompt).toContain('Find primary evidence')
  })
})
