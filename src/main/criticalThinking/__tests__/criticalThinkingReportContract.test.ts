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

/**
 * A section written as a bold label is a section.
 *
 * Every structural check required a markdown ATX heading. Measured across five
 * models on one question, two of them - DeepSeek-Coder-V2-Lite-16B and
 * gemma-3-27B - write their structure as whole-line bold labels instead, and
 * both were rejected as `structurally-invalid` with all the sections present:
 *
 *   **Title:** ... **Executive Summary:** ... **Findings:**
 *   **Conclusion:** ... **Limits and Open Questions:** ... **Sources:**
 *
 * The report named "Limits and Open Questions" was reported as missing a limits
 * section. Bold labels are ordinary markdown, and the contract was measuring
 * syntax rather than structure.
 *
 * It also made the repair loop useless: told to add sections it already had,
 * the model returned byte-identical text, so the run could never recover.
 */
describe('report contract: bold labels as sections', () => {
  const body = 'A substantive paragraph of findings with a citation [[S1:P1]] in it.'

  it('accepts a bold label as the limits section', () => {
    const report = [
      '**Title:** A report',
      '',
      body,
      '',
      '**Limits and Open Questions:**',
      '',
      'What could not be established.'
    ].join('\n')
    const issues = validateReportContract(report, 1).issues.join(' ')
    expect(issues).not.toContain('limits')
  })

  it('accepts a bold label carrying content on the same line as a title', () => {
    // `**Title:** An Assessment of ...` - the label and its text share a line.
    const report = ['**Title:** An Assessment', '', body, '', '**Conclusion:**', '', 'So.'].join(
      '\n'
    )
    expect(validateReportContract(report, 1).issues.join(' ')).not.toContain('no descriptive title')
  })

  it('accepts a bold label with no trailing colon', () => {
    // gemma writes `**Limits and open questions**`, DeepSeek writes it with a
    // colon inside the bold. Both are the same thing.
    const report = ['# A report', '', body, '', '**Limits and open questions**', '', 'Gaps.'].join(
      '\n'
    )
    expect(validateReportContract(report, 1).issues.join(' ')).not.toContain('limits')
  })

  it('still reports a genuinely missing section', () => {
    // The point is to read structure, not to stop requiring it.
    const report = ['# A report', '', body, '', '**Conclusion:**', '', 'So.'].join('\n')
    expect(validateReportContract(report, 1).issues.join(' ')).toContain('limits')
  })

  it('still reports a report with no structure at all', () => {
    expect(validateReportContract(body, 1).issues.join(' ')).toContain('no descriptive title')
  })

  it('does not treat mid-sentence bold emphasis as a heading', () => {
    // Bold used for emphasis inside a paragraph is not a section label.
    const report = ['Some prose with **emphasis** inside it and a citation [[S1:P1]].'].join('\n')
    expect(validateReportContract(report, 1).issues.join(' ')).toContain('no descriptive title')
  })
})
