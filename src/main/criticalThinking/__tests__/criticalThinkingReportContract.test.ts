import { describe, expect, it } from 'vitest'
import { validateReportContract } from '../criticalThinkingReportContract'

const WELL_FORMED_REPORT = `# Bee and Wasp Sting Comparison

## Executive Summary

Bee and wasp venoms differ substantially in composition and clinical effect [[S1:P1]].

## Findings

Honey bee venom is dominated by melittin, which drives much of its acute pain response [[S1:P1]].
Wasp venom instead relies on a broader mix of peptides and enzymes, producing different tissue effects [[S2:P1]].

## Limits and Open Questions

Repeat-sting behavior across species was not directly compared in the available sources.

## Sources

[[S1]] [[S2]]

## Conclusion

The two venoms differ in mechanism, and the practical implications depend on allergic history.
`

describe('validateReportContract', () => {
  it('rejects the exact reproduced 175-character live failure report', () => {
    const liveReport =
      '# Comparative Analysis of Hymenoptera Stings: Honey Bees, Bumblebees,\n\n' +
      '# Yellowjackets, Paper Wasps, and Hornets\n\n' +
      '## Executive Summary\n\n' +
      'This report synthesizes available evidence'

    const result = validateReportContract(liveReport, 7)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing a findings/results section'),
        expect.stringContaining('missing a limits/open-questions section'),
        expect.stringContaining('missing a sources section'),
        expect.stringContaining('missing a conclusion/summary section'),
        expect.stringContaining('cited substantive block'),
        expect.stringContaining('unfinished heading or sentence')
      ])
    )
  })

  it('accepts a well-formed report with all required sections and enough cited substance', () => {
    const result = validateReportContract(WELL_FORMED_REPORT, 2)

    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.citedSubstantiveBlockCount).toBeGreaterThanOrEqual(2)
  })

  it('rejects a report missing just the sources section', () => {
    const withoutSources = WELL_FORMED_REPORT.replace(/## Sources[\s\S]*?(?=## Conclusion)/, '')

    const result = validateReportContract(withoutSources, 2)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual([expect.stringContaining('missing a sources section')])
  })

  it('rejects a report with only one cited block when several steps were researched', () => {
    const oneBlockReport = `# Narrow Report

## Executive Summary

Only one finding was substantiated [[S1:P1]].

## Findings

Only one finding was substantiated [[S1:P1]].

## Limits and Open Questions

Most steps found nothing conclusive.

## Sources

[[S1]]

## Conclusion

The investigation remains inconclusive overall.
`

    const result = validateReportContract(oneBlockReport, 7)

    expect(result.valid).toBe(false)
    expect(result.issues.some((issue) => issue.includes('cited substantive block'))).toBe(true)
  })

  it('rejects an empty report', () => {
    expect(validateReportContract('   ', 3)).toEqual({
      valid: false,
      issues: ['The report is empty.'],
      substantiveBlockCount: 0,
      citedSubstantiveBlockCount: 0
    })
  })

  it('flags a report that ends mid-sentence with no terminal punctuation', () => {
    const truncated = WELL_FORMED_REPORT.trimEnd() + '\n\nThe two venoms differ in mechanism, and'

    const result = validateReportContract(truncated, 2)

    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('unfinished heading or sentence')])
    )
  })
})
