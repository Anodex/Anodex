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

    // Still rejected — it has no gap acknowledgment, no cited substance, and
    // ends mid-sentence. (Findings/Sources are no longer required as named
    // headings, and its "## Executive Summary" now satisfies the summary
    // requirement — so those specific misses are gone, but the real defects
    // remain.)
    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('limits, gaps, or open-questions'),
        expect.stringContaining('cited substantive block'),
        expect.stringContaining('unfinished heading or sentence')
      ])
    )
  })

  it('accepts a report organized as numbered sections with an Executive Summary and Evidence Gaps', () => {
    // The exact live shape that was wrongly demoted: numbered content sections,
    // an executive summary, gaps flagged as "Evidence Gaps", inline citations,
    // and no literal "## Findings"/"## Sources"/"## Conclusion" headings.
    const numberedReport = `# Comparative Sting Effects

## Executive Summary

Honey bees and yellowjackets both rate Level 2 on the Schmidt scale [[S1:P1]].

## 1. Pain Intensity

Melittin is the primary pain-causing agent in honey bee venom [[S1:P1]].

## 2. Tissue Effects

Wasp venom relies on a broader peptide mix producing distinct effects [[S1:P1]].

### 2.2 Evidence Gaps

No species-specific necrosis data exists in the provided evidence.
`

    const result = validateReportContract(numberedReport, 3)

    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('accepts a well-formed report with all required sections and enough cited substance', () => {
    const result = validateReportContract(WELL_FORMED_REPORT, 2)

    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.citedSubstantiveBlockCount).toBeGreaterThanOrEqual(2)
  })

  it('accepts a report that closes with a Recommendations section instead of Conclusion', () => {
    // The synthesis prompt invites "a clear conclusion or recommendation", so a
    // report ending in "## Recommendations" must satisfy the section contract
    // rather than being discarded for the deterministic fallback.
    const withRecommendations = WELL_FORMED_REPORT.replace(
      '## Conclusion\n\nThe two venoms differ in mechanism, and the practical implications depend on allergic history.',
      '## Recommendations\n\nCarry an epinephrine auto-injector if a prior systemic reaction occurred [[S1:P1]].'
    )

    const result = validateReportContract(withRecommendations, 2)

    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('accepts an Executive Summary as the summary section when gaps are acknowledged', () => {
    // An executive summary that summarizes the report satisfies the summary
    // requirement — a report summarized up front needs no redundant closing
    // section, provided it acknowledges limits and carries cited substance.
    const summarizedUpFront = `# Report

## Executive Summary

Bees and wasps differ in venom composition and clinical effect [[S1:P1]].

## 1. Findings

Bee venom is dominated by melittin [[S1:P1]]. Wasp venom relies on peptides [[S2:P1]].

## Limits and Open Questions

Some steps were not reached.
`

    const result = validateReportContract(summarizedUpFront, 2)

    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('rejects a report that never acknowledges its limits or gaps', () => {
    const withoutLimits = WELL_FORMED_REPORT.replace(
      /## Limits and Open Questions[\s\S]*?(?=## Sources)/,
      ''
    )

    const result = validateReportContract(withoutLimits, 2)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual([expect.stringContaining('limits, gaps, or open-questions')])
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
