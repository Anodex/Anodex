import { describe, expect, it } from 'vitest'
import type {
  CriticalThinkingSource,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { buildDeterministicFallbackReport } from '../criticalThinkingFallbackReport'
import { validateResearchReport } from '../criticalThinkingEvidence'
import { validateReportContract } from '../criticalThinkingReportContract'

function step(overrides: Partial<CriticalThinkingStepState>): CriticalThinkingStepState {
  return {
    id: overrides.id ?? 'step-1',
    title: overrides.title ?? 'Investigate the evidence',
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? 1,
    evidenceIds: overrides.evidenceIds ?? [],
    finding: overrides.finding ?? '',
    uncertainties: overrides.uncertainties ?? [],
    rounds: overrides.rounds ?? [],
    terminationReason: overrides.terminationReason
  }
}

function fetchArtifact(
  id: string,
  stepId: string,
  url: string,
  passages: Array<{ id: string; text: string }>
): ToolArtifact {
  return {
    id,
    conversationId: 'run_1',
    messageId: `message_${id}`,
    createdAt: 1,
    kind: 'web-fetch',
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: 'text/html',
    title: 'Fetched source',
    contentHash: `hash-${id}`,
    contentChars: 200,
    truncated: false,
    passages: passages.map((passage) => ({ ...passage, score: 100 })),
    warnings: [],
    research: { stepId, roundId: `round-${stepId}` }
  }
}

describe('buildDeterministicFallbackReport (P0-H)', () => {
  const steps: CriticalThinkingStepState[] = [
    step({
      id: 'step-1',
      title: 'Compare venom composition across species',
      status: 'completed',
      evidenceIds: ['artifact-1'],
      finding: 'Bee venom differs from wasp venom in composition.',
      uncertainties: []
    }),
    step({
      id: 'step-2',
      title: 'Compare pain-scale ratings from primary studies',
      status: 'limited',
      evidenceIds: ['artifact-2'],
      finding: '',
      uncertainties: ['Schmidt index coverage across all five species is incomplete.']
    }),
    step({
      id: 'step-3',
      title: 'Check allergic-reaction and repeat-sting evidence',
      status: 'limited',
      evidenceIds: [],
      finding: '',
      uncertainties: []
    }),
    step({
      id: 'step-4',
      title: 'Review repeat-sting behavioral ecology',
      status: 'pending',
      evidenceIds: [],
      finding: '',
      uncertainties: []
    })
  ]

  const sources: CriticalThinkingSource[] = [
    {
      id: 'S1',
      title: 'Venom composition review',
      url: 'https://example.com/venom',
      verified: true
    },
    { id: 'S2', title: 'Pain index study', url: 'https://example.com/pain', verified: true }
  ]

  const artifacts: ToolArtifact[] = [
    fetchArtifact('artifact-1', 'step-1', 'https://example.com/venom', [
      { id: 'P1', text: 'Bee venom is dominated by melittin, driving its acute pain response.' }
    ]),
    fetchArtifact('artifact-2', 'step-2', 'https://example.com/pain', [
      { id: 'P1', text: 'The Schmidt sting pain index ranks bullet ant stings highest overall.' }
    ])
  ]

  it('produces a report that passes both citation-safety and report-contract validation', () => {
    const report = buildDeterministicFallbackReport(
      'Bee and Wasp Sting Comparison',
      steps,
      artifacts,
      sources
    )

    const citation = validateResearchReport(report, artifacts, sources)
    // Scored against how many steps actually have evidence (2), not the full
    // plan size (4) — an honest partial report that clearly labels 2 steps
    // as "not reached"/"limited" should not be required to fabricate
    // citations for steps it never got to. The service must apply the same
    // evidence-based count when it validates the fallback it builds.
    const stepsWithEvidence = steps.filter((step) => step.evidenceIds.length > 0).length
    const contract = validateReportContract(report, stepsWithEvidence)

    expect(citation.issues).toEqual([])
    expect(citation.valid).toBe(true)
    expect(contract.issues).toEqual([])
    expect(contract.valid).toBe(true)
  })

  it('cites verified passages directly instead of promoting an uncited model finding', () => {
    const report = buildDeterministicFallbackReport(
      'Bee and Wasp Sting Comparison',
      steps,
      artifacts,
      sources
    )

    // step-1's model `finding` prose is never promoted verbatim...
    expect(report).not.toContain('Bee venom differs from wasp venom in composition.')
    // ...only the actual fetched passage text, with its real citation, is.
    expect(report).toContain('Bee venom is dominated by melittin')
    expect(report).toContain('[[S1:P1]]')
  })

  it('labels untouched and limited steps without fabricating findings for them', () => {
    const report = buildDeterministicFallbackReport(
      'Bee and Wasp Sting Comparison',
      steps,
      artifacts,
      sources
    )

    expect(report).toContain('steps not reached')
    expect(report).toContain('steps limited')
    expect(report).toContain('Review repeat-sting behavioral ecology')
    expect(report).toContain('Not investigated.')
  })

  it('surfaces recorded uncertainties in the limits section', () => {
    const report = buildDeterministicFallbackReport(
      'Bee and Wasp Sting Comparison',
      steps,
      artifacts,
      sources
    )

    expect(report).toContain('Schmidt index coverage across all five species is incomplete')
  })

  it('keeps researching steps with retained evidence out of the not-reached count', () => {
    const researching = step({
      id: 'step-1',
      title: 'Research in progress',
      status: 'researching',
      evidenceIds: ['artifact-1'],
      rounds: [
        {
          id: 'round-1',
          index: 0,
          status: 'completed',
          queries: ['query'],
          selectedUrls: ['https://example.com/venom'],
          evidenceIds: ['artifact-1'],
          finding: '',
          assessment: null,
          startedAt: 1,
          completedAt: 2
        }
      ]
    })

    const report = buildDeterministicFallbackReport(
      'Research in progress',
      [researching],
      artifacts,
      sources
    )

    expect(report).not.toContain('steps not reached')
  })

  it('degrades safely with zero verified sources, without crashing or fabricating a citation', () => {
    // This exact combination (a research attempt with literally no verified
    // sources) never actually reaches the fallback builder in production —
    // CriticalThinkingService.runSynthesis() already returns Partial before
    // attempting synthesis at all when verifiedSources.length === 0. Kept as
    // a defensive test of the builder in isolation: a report with literally
    // no evidence cannot pass validateResearchReport's "must cite something"
    // rule — there is nothing to cite — so citation validity isn't asserted
    // here; what matters is that the builder still produces well-formed,
    // honest output instead of throwing or inventing a source.
    const emptySteps = [step({ id: 'only-step', status: 'limited', title: 'Only step' })]

    const report = buildDeterministicFallbackReport('Empty Investigation', emptySteps, [], [])

    expect(report).toContain('None verified.')
    expect(report).toContain('# Research result: Empty Investigation')
    expect(report).not.toMatch(/\[\[S\d+/)
  })
})
