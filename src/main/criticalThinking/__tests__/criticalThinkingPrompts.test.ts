import { describe, expect, it } from 'vitest'
import type { Plan } from '@shared/plan.types'
import {
  buildCriticalThinkingPlanPrompt,
  buildCriticalThinkingResearchPrompt
} from '../criticalThinkingPrompts'

describe('Critical Thinking prompts', () => {
  it('keeps the planning stage action-free and requires write_plan', () => {
    const prompt = buildCriticalThinkingPlanPrompt('Which option is best?')

    expect(prompt).toContain('calling write_plan')
    expect(prompt).toContain('Do not answer the question or search yet')
    expect(prompt).toContain('Which option is best?')
  })

  it('requires web evidence, cross-checking, and linked citations in the report', () => {
    const plan: Plan = {
      title: 'Compare the evidence',
      steps: [
        { id: 'one', title: 'Find primary evidence', status: 'pending' },
        { id: 'two', title: 'Cross-check the findings', status: 'pending' }
      ],
      updatedAt: 1
    }
    const prompt = buildCriticalThinkingResearchPrompt('Which option is best?', plan)

    expect(prompt).toContain('Use web_search repeatedly')
    expect(prompt).toContain('Open promising sources with fetch_url')
    expect(prompt).toContain('Cross-check important claims')
    expect(prompt).toContain('[Source title](https://example.com/page)')
    expect(prompt).toContain('Find primary evidence')
  })
})
