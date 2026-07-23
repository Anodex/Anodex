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

  it('keeps the limits section concise and deduplicates repeated gaps', () => {
    const first = step('one', 'A very detailed toxicology comparison')
    first.uncertainties = [
      'Species-specific primary data were not retrieved.',
      'Dose-normalized results remain uncertain.',
      'This third optional gap should not be listed.',
      'This fourth optional gap should not be listed.'
    ]
    const second = step('two', 'Clinical outcomes')
    second.uncertainties = [
      'Species-specific primary data were not retrieved.',
      'Longitudinal follow-up was not retrieved.',
      'Another optional gap should not be listed.'
    ]
    const report = assembleHierarchicalReport({
      title: 'Concise limits',
      steps: [first, second],
      sections: new Map(),
      overview: null,
      sources: []
    })
    const limits = /## Limits and Open Questions\s+([\s\S]*?)\s+## Sources/.exec(report)?.[1] ?? ''

    expect(limits).toContain('Species-specific primary data')
    expect(limits.match(/Species-specific primary data/g)).toHaveLength(1)
    expect(limits).toContain('Dose-normalized results')
    expect(limits).toContain('Longitudinal follow-up')
    expect(limits).not.toContain('third optional gap')
    expect(limits).not.toContain('Another optional gap')
  })
})
