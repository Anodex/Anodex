import { describe, expect, it } from 'vitest'
import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import {
  chooseBetterReportCandidate,
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
    expect(withPreamble.valid).toBe(clean.valid)
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
