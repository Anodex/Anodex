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
})
