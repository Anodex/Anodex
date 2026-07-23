import { describe, expect, it } from 'vitest'
import type {
  CriticalThinkingSource,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import { assembleHierarchicalReport } from '../criticalThinkingHierarchicalReport'

function step(id: string, title: string): CriticalThinkingStepState {
  return {
    id,
    title,
    status: 'completed',
    attempts: 1,
    evidenceIds: [`artifact-${id}`],
    finding: '',
    uncertainties: [],
    rounds: []
  }
}

describe('hierarchical report assembly', () => {
  it('builds a non-repeating overview and lists only sources cited by retained content', () => {
    const steps = [step('one', 'Toxicology'), step('two', 'Pain comparison')]
    const sources: CriticalThinkingSource[] = [
      { id: 'S1', title: 'Used study', url: 'https://example.com/used', verified: true },
      { id: 'S2', title: 'Unused study', url: 'https://example.com/unused', verified: true }
    ]
    const distinctiveDetail = 'A second mechanistic detail belongs only in the full section.'
    const report = assembleHierarchicalReport({
      title: 'Comparative report',
      steps,
      sections: new Map([
        [
          'one',
          `The first retained toxicology result is evidence-backed [[S1:P1]].\n\n${distinctiveDetail} [[S1:P1]].`
        ],
        ['two', 'The retained pain comparison is independently supported [[S1:P1]].']
      ]),
      overview: null,
      sources
    })
    const sourcesSection = /## Sources\s+([\s\S]*?)\s+## Conclusion/.exec(report)?.[1] ?? ''

    expect(report).toContain('### 1. Toxicology')
    expect(report).toContain('### 2. Pain comparison')
    expect(report.match(new RegExp(distinctiveDetail, 'g'))).toHaveLength(1)
    expect(sourcesSection).toContain('[[S1]]')
    expect(sourcesSection).not.toContain('[[S2]]')
  })
})
