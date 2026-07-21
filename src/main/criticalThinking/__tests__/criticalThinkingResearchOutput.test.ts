import { describe, expect, it } from 'vitest'
import {
  parseResearchAssessment,
  parseResearchPlan,
  parseResearchQueries
} from '../criticalThinkingResearchOutput'

describe('Critical Thinking staged research output parsing', () => {
  it('accepts a bounded plan with 3 to 7 distinct steps and service-generated IDs', () => {
    const parsed = parseResearchPlan(
      JSON.stringify({
        title: 'Bee and Wasp Sting Pain Research',
        steps: [
          'Compare venom composition across species',
          'Compare pain-scale ratings from primary studies',
          'Check allergic-reaction and repeat-sting evidence'
        ]
      })
    )

    expect(parsed.valid).toBe(true)
    expect(parsed.issues).toEqual([])
    expect(parsed.plan?.title).toBe('Bee and Wasp Sting Pain Research')
    expect(parsed.plan?.steps).toHaveLength(3)
    expect(parsed.plan?.steps.every((step) => step.status === 'pending')).toBe(true)
    const ids = new Set(parsed.plan?.steps.map((step) => step.id))
    expect(ids.size).toBe(3)
  })

  it('deduplicates trivially repeated steps and caps the list at 7', () => {
    const parsed = parseResearchPlan(
      JSON.stringify({
        title: 'Research plan',
        steps: [
          'First distinct step',
          'FIRST DISTINCT STEP',
          'Second distinct step',
          'Third distinct step',
          'Fourth distinct step',
          'Fifth distinct step',
          'Sixth distinct step',
          'Seventh distinct step',
          'Eighth distinct step'
        ]
      })
    )

    expect(parsed.valid).toBe(true)
    expect(parsed.plan?.steps).toHaveLength(7)
    expect(parsed.plan?.steps[0].title).toBe('First distinct step')
  })

  it('rejects a plan with fewer than 3 usable steps and reports why', () => {
    const parsed = parseResearchPlan(
      JSON.stringify({ title: 'Too short', steps: ['Only one step'] })
    )

    expect(parsed.valid).toBe(false)
    expect(parsed.plan).toBeNull()
    expect(parsed.issues.join(' ')).toContain('at least 3')
  })

  it('rejects a plan with no title and reports why', () => {
    const parsed = parseResearchPlan(
      JSON.stringify({
        title: '   ',
        steps: ['First distinct step', 'Second distinct step', 'Third distinct step']
      })
    )

    expect(parsed.valid).toBe(false)
    expect(parsed.plan).toBeNull()
    expect(parsed.issues.join(' ')).toContain('non-empty title')
  })

  it('rejects text that is not a JSON object', () => {
    const parsed = parseResearchPlan('I will now think about a plan...')

    expect(parsed.valid).toBe(false)
    expect(parsed.plan).toBeNull()
    expect(parsed.issues).not.toEqual([])
  })
  it('extracts a balanced JSON object embedded in model prose', () => {
    const parsed = parseResearchQueries(
      'Template {not json}. Result {"queries":["alpha {dataset} report","beta study"]} trailing {noise}',
      'fallback query',
      3
    )

    expect(parsed).toEqual({
      queries: ['alpha {dataset} report', 'beta study'],
      valid: true
    })
  })

  it('keeps usable bounded queries but flags a malformed array', () => {
    const parsed = parseResearchQueries(
      '{"queries":[" first   query ",42,"FIRST QUERY","second query"]}',
      'fallback query',
      2
    )

    expect(parsed).toEqual({ queries: ['first query', 'second query'], valid: false })
    expect(parseResearchQueries('{}', '  fallback\nquery  ', 1)).toEqual({
      queries: ['fallback query'],
      valid: false
    })
    expect(parseResearchQueries('{}', 'fallback query', 0)).toEqual({
      queries: [],
      valid: false
    })
  })

  it('accepts only the complete assessment schema and exact enum values', () => {
    const valid = parseResearchAssessment(
      JSON.stringify({
        finding: 'The evidence answers the narrow step.',
        uncertainties: [],
        verdict: 'sufficient',
        evidenceBasis: 'authoritative-primary',
        rationale: 'The fetched page is the controlling primary source.',
        remainingGaps: [],
        nextQueries: []
      }),
      3
    )

    expect(valid.valid).toBe(true)
    expect(valid.assessment).toMatchObject({
      verdict: 'sufficient',
      evidenceBasis: 'authoritative-primary'
    })

    const invalid = parseResearchAssessment(
      JSON.stringify({
        finding: 'Unsupported decision',
        uncertainties: [],
        verdict: 'yes',
        evidenceBasis: 'probably',
        rationale: 'The schema values are invalid.',
        remainingGaps: []
      }),
      3
    )

    expect(invalid.valid).toBe(false)
    expect(invalid.assessment).toBeNull()
    expect(invalid.finding).toBe('Unsupported decision')
  })

  it('accepts a sufficient assessment that omits the gap/query keys entirely', () => {
    // The exact local-model shape behind "A valid evidence coverage assessment
    // is still required": a correct "sufficient, no gaps" decision that simply
    // does not include remainingGaps/nextQueries/uncertainties keys. Requiring
    // those keys used to reject it, so a fully-covered step never completed.
    const parsed = parseResearchAssessment(
      JSON.stringify({
        finding: 'The primary source settles the narrow step.',
        verdict: 'sufficient',
        evidenceBasis: 'authoritative-primary',
        rationale: 'The fetched primary source is definitive for this step.'
      }),
      3
    )

    expect(parsed.valid).toBe(true)
    expect(parsed.assessment).toMatchObject({
      verdict: 'sufficient',
      evidenceBasis: 'authoritative-primary'
    })
    expect(parsed.assessment?.remainingGaps).toEqual([])
    expect(parsed.assessment?.nextQueries).toEqual([])
  })

  it('tolerates local-model enum formatting drift in verdict and evidenceBasis', () => {
    const parsed = parseResearchAssessment(
      JSON.stringify({
        finding: 'Two independent sources agree.',
        verdict: 'Sufficient.',
        evidenceBasis: 'Multiple Sources',
        rationale: 'Two fetched sources independently confirm the claim.'
      }),
      3
    )

    expect(parsed.valid).toBe(true)
    expect(parsed.assessment).toMatchObject({
      verdict: 'sufficient',
      evidenceBasis: 'multiple-sources'
    })
  })

  it('still rejects a genuinely unrecognized verdict or evidenceBasis value', () => {
    const parsed = parseResearchAssessment(
      JSON.stringify({
        finding: 'Ambiguous',
        verdict: 'maybe',
        evidenceBasis: 'a little',
        rationale: 'Unclear.'
      }),
      3
    )

    expect(parsed.valid).toBe(false)
    expect(parsed.assessment).toBeNull()
  })

  it('bounds and deduplicates assessment lists', () => {
    const parsed = parseResearchAssessment(
      JSON.stringify({
        finding: 'Partial finding',
        uncertainties: [' Gap one ', 'gap one', 'Gap two'],
        verdict: 'continue',
        evidenceBasis: 'insufficient',
        rationale: 'More evidence is required.',
        remainingGaps: [' Gap one ', 'gap one', 'Gap two'],
        nextQueries: [' follow up ', 'FOLLOW UP', 'second query']
      }),
      2
    )

    expect(parsed.uncertainties).toEqual(['Gap one', 'Gap two'])
    expect(parsed.assessment?.remainingGaps).toEqual(['Gap one', 'Gap two'])
    expect(parsed.assessment?.nextQueries).toEqual(['follow up', 'second query'])
  })
})
