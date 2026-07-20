import { describe, expect, it } from 'vitest'
import { parseResearchAssessment, parseResearchQueries } from '../criticalThinkingResearchOutput'

describe('Critical Thinking staged research output parsing', () => {
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
