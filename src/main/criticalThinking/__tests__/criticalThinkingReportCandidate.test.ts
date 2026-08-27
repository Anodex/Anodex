import { describe, expect, it } from 'vitest'
import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import {
  chooseBetterReportCandidate,
  discloseUnverifiedQuotations,
  evaluateReportCandidate
} from '../criticalThinkingReportCandidate'

const SOURCE: CriticalThinkingSource = {
  id: 'S1',
  title: 'Primary study',
  url: 'https://example.com/study',
  verified: true
}

function artifact(): ToolArtifact {
  return {
    id: 'artifact_1',
    conversationId: 'run_1',
    messageId: 'message_1',
    createdAt: 1,
    kind: 'web-fetch',
    requestedUrl: SOURCE.url,
    finalUrl: SOURCE.url,
    status: 200,
    contentType: 'text/html',
    title: SOURCE.title,
    contentHash: 'hash',
    contentChars: 200,
    truncated: false,
    passages: [
      { id: 'P1', text: 'Bee venom triggers a sharper pain response than wasp venom.', score: 100 }
    ],
    warnings: []
  }
}

const WELL_FORMED = `# Bee and Wasp Sting Comparison

## Executive Summary

Bee venom triggers a sharper pain response than wasp venom [[S1:P1]].

## Findings

Bee venom triggers a sharper pain response than wasp venom, per direct comparison [[S1:P1]].

## Limits and Open Questions

Repeat-sting behavior was not covered by the available sources.

## Sources

[[S1]]

## Conclusion

The two venoms differ in mechanism and clinical effect.
`

describe('evaluateReportCandidate / chooseBetterReportCandidate', () => {
  it('a worse nonempty repair does not replace a better invalid original (P0-F)', () => {
    const original = evaluateReportCandidate(WELL_FORMED, [artifact()], [SOURCE], 1)
    const repaired = evaluateReportCandidate('Bee stings hurt.', [artifact()], [SOURCE], 1)

    const selected = chooseBetterReportCandidate(original, repaired)

    expect(selected.content).toBe(original.content)
  })

  it('a repair that actually fixes validation issues replaces the original', () => {
    const invalidOriginal = evaluateReportCandidate(
      'Bee stings caused 89 fatalities last year.',
      [artifact()],
      [SOURCE],
      1
    )
    const validRepair = evaluateReportCandidate(WELL_FORMED, [artifact()], [SOURCE], 1)

    const selected = chooseBetterReportCandidate(invalidOriginal, validRepair)

    expect(selected.content).toBe(validRepair.content)
  })

  it('prefers the candidate with more cited substantive coverage when both are otherwise invalid', () => {
    const thin = evaluateReportCandidate('A short uncited claim only.', [], [], 3)
    const richer = evaluateReportCandidate(
      'A short uncited claim only. Another distinct uncited claim follows here.',
      [],
      [],
      3
    )

    const selected = chooseBetterReportCandidate(thin, richer)

    // Neither validates and both have identical issue/cited-block counts, so
    // the final tie-breaker (length) picks the longer, more substantive draft.
    expect(selected.content).toBe(richer.content)
  })

  it('never picks a candidate solely because it is newer/nonempty when it is strictly worse', () => {
    const original = evaluateReportCandidate(WELL_FORMED, [artifact()], [SOURCE], 1)
    const emptyRepair = evaluateReportCandidate('', [artifact()], [SOURCE], 1)

    expect(chooseBetterReportCandidate(original, emptyRepair).content).toBe(original.content)
  })

  it('marks a safe, richly-cited but imperfectly-structured report usable though not valid', () => {
    // The live case: the model wrote a real report organized as numbered
    // sections — safe (every citation resolves) and substantial, but missing
    // the exact section skeleton, so `overallValid` is false. `usable` is what
    // the service relies on to keep it instead of building the fallback.
    const richButUnstructured = `# Comparative Sting Effects

Bee venom is dominated by melittin, a pore-forming peptide [[S1:P1]].

Wasp venom relies on a broader peptide mix producing distinct tissue effects [[S1:P1]].

A third substantiated finding on pain mechanism follows here [[S1:P1]].`
    const candidate = evaluateReportCandidate(richButUnstructured, [artifact()], [SOURCE], 3)

    expect(candidate.safe).toBe(true)
    expect(candidate.usable).toBe(true)
    expect(candidate.overallValid).toBe(false)
  })

  it('marks a fabricating report unsafe and unusable, and never lets it win', () => {
    const fabricating = evaluateReportCandidate(
      'Bee venom killed 89 people last year [[S1:P1]]. A second fabricated statistic of 42 percent applies [[S1:P1]]. A third invented figure of 7 is asserted [[S1:P1]].',
      [artifact()],
      [SOURCE],
      3
    )
    const usableFallback = evaluateReportCandidate(WELL_FORMED, [artifact()], [SOURCE], 2)

    expect(fabricating.safe).toBe(false)
    expect(fabricating.usable).toBe(false)
    expect(usableFallback.usable).toBe(true)
    // An unsafe (fabricating) draft never wins over a usable one.
    expect(chooseBetterReportCandidate(fabricating, usableFallback).content).toBe(
      usableFallback.content
    )
    expect(chooseBetterReportCandidate(usableFallback, fabricating).content).toBe(
      usableFallback.content
    )
  })
})

describe('model preamble', () => {
  it('scores the report, not the narration the model wrote first', () => {
    // Measured on a real run: a repair pass narrated "I'll repair the report
    // by checking each flagged quote..." then "Here is the complete repaired
    // report:" then the report. The narration was scored as report text,
    // carried no citation, and cost the repair three issues of its own -- so
    // it lost to the draft it was meant to improve.
    const narrated =
      "I'll repair the report by checking each flagged quote against the evidence packet.\n\n" +
      'Key findings from the packet before I write: the venom comparison holds.\n\n' +
      'Here is the complete repaired report:\n\n' +
      WELL_FORMED

    const clean = evaluateReportCandidate(WELL_FORMED, [artifact()], [SOURCE], 1)
    const withPreamble = evaluateReportCandidate(narrated, [artifact()], [SOURCE], 1)

    expect(withPreamble.issues).toEqual(clean.issues)
    expect(withPreamble.overallValid).toBe(clean.overallValid)
    expect(withPreamble.safe).toBe(clean.safe)
    expect(withPreamble.citedSubstantiveBlockCount).toBe(clean.citedSubstantiveBlockCount)
  })

  it('leaves a report that already starts with its title alone', () => {
    const candidate = evaluateReportCandidate(WELL_FORMED, [artifact()], [SOURCE], 1)
    expect(candidate.content.startsWith('# Bee and Wasp Sting Comparison')).toBe(true)
  })

  it('keeps a response whose heading is too late to be a preface', () => {
    // Guard against silently discarding the bulk of a response that merely
    // happens to carry a heading near the end.
    const mostlyProse = `${'Some uncited prose. '.repeat(140)}\n\n${WELL_FORMED}`
    const candidate = evaluateReportCandidate(mostlyProse, [artifact()], [SOURCE], 1)

    expect(candidate.content.startsWith('Some uncited prose.')).toBe(true)
  })
})

describe('unverified quotations', () => {
  const UNTRACEABLE =
    'Quoted text is not present in its cited fetched passages: “set as system center”'

  it('discloses them in the report’s own limits section', () => {
    const report = `${WELL_FORMED}\n\n## Limits and Open Questions\n\nNothing on pricing.`
    const disclosed = discloseUnverifiedQuotations(report, [UNTRACEABLE])

    expect(disclosed).toContain('Nothing on pricing.')
    expect(disclosed).toContain('could not be matched to their cited source')
    expect(disclosed).toContain('set as system center')
    // The analysis itself is untouched.
    expect(disclosed).toContain('Bee venom triggers a sharper pain response')
  })

  it('keeps the disclosure inside limits, before the sections that follow', () => {
    // WELL_FORMED is the real shape: Limits, then Sources, then Conclusion.
    // The disclosure belongs with the limits, not appended after everything.
    const disclosed = discloseUnverifiedQuotations(WELL_FORMED, [UNTRACEABLE])

    const existingLimit = disclosed.indexOf('Repeat-sting behavior')
    const disclosureAt = disclosed.indexOf('could not be matched')
    const sourcesAt = disclosed.indexOf('## Sources')

    expect(disclosureAt).toBeGreaterThan(existingLimit)
    expect(disclosureAt).toBeLessThan(sourcesAt)
    expect(disclosed).toContain('## Conclusion')
  })

  it('adds a limits section when the report has none', () => {
    const noLimits = `# Title

## Findings

Something [[S1:P1]].`
    const disclosed = discloseUnverifiedQuotations(noLimits, [UNTRACEABLE])

    expect(disclosed).toContain('## Limits and Open Questions')
    expect(disclosed).toContain('set as system center')
    expect(disclosed.indexOf('## Limits')).toBeGreaterThan(disclosed.indexOf('## Findings'))
  })

  it('changes nothing when every quotation checked out', () => {
    expect(discloseUnverifiedQuotations(WELL_FORMED, [])).toBe(WELL_FORMED)
  })

  it('keeps a report usable when a quotation cannot be traced', () => {
    // The whole point: a report answering the question must not be replaced by
    // one that says less merely because one attribution is loose.
    const withBadQuote = WELL_FORMED.replace(
      'Bee venom triggers a sharper pain response than wasp venom [[S1:P1]].',
      'Bee venom triggers a sharper pain response than wasp venom [[S1:P1]]. ' +
        'They wrote "a total collapse of every measured outcome" [[S1:P1]].'
    )
    const candidate = evaluateReportCandidate(withBadQuote, [artifact()], [SOURCE], 1)

    expect(candidate.unverifiedQuotations.length).toBeGreaterThan(0)
    expect(candidate.safe).toBe(false)
    expect(candidate.usable).toBe(true)
  })

  it('still refuses a report whose quotations are mostly untraceable', () => {
    const fabricated = `# Fabricated\n\n## Executive Summary\n\n${[
      'They said "a total collapse of every measured outcome" [[S1:P1]].',
      'And "another sentence that appears in no source at all" [[S1:P1]].',
      'And "a third invented line nobody ever wrote down" [[S1:P1]].',
      'And "a fourth invented line nobody ever wrote down" [[S1:P1]].'
    ].join('\n\n')}`
    const candidate = evaluateReportCandidate(fabricated, [artifact()], [SOURCE], 1)

    expect(candidate.usable).toBe(false)
  })

  it('still refuses a report with a fabricated figure', () => {
    // Only quotations are disclosable. An invented number stays fatal.
    const withBadNumber = WELL_FORMED.replace(
      'Bee venom triggers a sharper pain response than wasp venom [[S1:P1]].',
      'The improvement was 91.7 percent [[S1:P1]].'
    )
    const candidate = evaluateReportCandidate(withBadNumber, [artifact()], [SOURCE], 1)

    expect(candidate.usable).toBe(false)
  })
})
