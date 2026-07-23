import { describe, expect, it } from 'vitest'
import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import {
  applyCriticalThinkingConsistencyCorrections,
  parseCriticalThinkingConsistencyReview,
  sectionsNeedConsistencyReview
} from '../criticalThinkingConsistency'

const source: CriticalThinkingSource = {
  id: 'S1',
  title: 'Primary review',
  url: 'https://pubmed.ncbi.nlm.nih.gov/123456/',
  verified: true
}
const artifact: ToolArtifact = {
  id: 'artifact-1',
  conversationId: 'run-1',
  messageId: 'message-1',
  createdAt: 1,
  kind: 'web-fetch',
  requestedUrl: source.url,
  finalUrl: source.url,
  status: 200,
  contentType: 'text/html',
  title: source.title,
  contentHash: 'hash',
  contentChars: 200,
  truncated: false,
  passages: [
    {
      id: 'P1',
      text: 'The bounded review retrieved evidence about venom composition, but direct cross-species estimates were limited.',
      score: 100
    }
  ],
  warnings: []
}

describe('Critical Thinking consistency review', () => {
  it('detects overbroad absence language and parses bounded corrections', () => {
    const sections = new Map([
      ['one', 'No evidence exists for the composition comparison [[S1:P1]].'],
      ['two', 'The review retrieved limited comparative evidence [[S1:P1]].']
    ])
    const parsed = parseCriticalThinkingConsistencyReview(
      JSON.stringify({
        corrections: [
          {
            stepId: 'one',
            find: 'No evidence exists for the composition comparison [[S1:P1]].',
            replace:
              'This bounded run retrieved limited direct evidence for the composition comparison [[S1:P1]].'
          }
        ]
      })
    )

    expect(sectionsNeedConsistencyReview(sections)).toBe(true)
    expect(parsed).toHaveLength(1)
  })

  it('applies only exact corrections that remain citation-safe', () => {
    const original = 'No evidence exists for the composition comparison [[S1:P1]].'
    const sections = new Map([
      ['one', original],
      ['two', 'The review retrieved limited comparative evidence [[S1:P1]].']
    ])
    const applied = applyCriticalThinkingConsistencyCorrections(
      sections,
      [
        {
          stepId: 'one',
          find: original,
          replace:
            'This bounded run retrieved limited direct evidence for the composition comparison [[S1:P1]].'
        },
        {
          stepId: 'two',
          find: 'A sentence that is not present in the section.',
          replace: 'This replacement should never be applied [[S1:P1]].'
        }
      ],
      [artifact],
      [source]
    )

    expect(applied.accepted).toBe(1)
    expect(applied.sections.get('one')).toContain('This bounded run retrieved')
    expect(applied.issues).toHaveLength(1)
  })
})
