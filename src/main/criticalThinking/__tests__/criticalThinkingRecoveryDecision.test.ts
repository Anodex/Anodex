import { describe, expect, it } from 'vitest'
import type { ReportCandidate } from '../criticalThinkingReportCandidate'
import { reportNeedsHierarchicalRecovery } from '../criticalThinkingRecoveryDecision'

const candidate = (over: Partial<ReportCandidate>): ReportCandidate =>
  ({
    content: '',
    safe: true,
    usable: true,
    overallValid: true,
    structurallyValid: true,
    unverifiedQuotations: [],
    unverifiedFigures: [],
    otherSafetyIssues: [],
    usableBlockers: [],
    issues: [],
    contractIssues: [],
    issueCount: 0,
    citedSubstantiveBlockCount: 10,
    length: 20_000,
    ...over
  }) as ReportCandidate

describe('reportNeedsHierarchicalRecovery', () => {
  it('recovers an unusable report whatever its coverage', () => {
    expect(reportNeedsHierarchicalRecovery(candidate({ usable: false }), 6, 1)).toBe(true)
  })

  it('recovers a report that cites less than once per researched step', () => {
    expect(
      reportNeedsHierarchicalRecovery(candidate({ citedSubstantiveBlockCount: 5 }), 6, 1)
    ).toBe(true)
  })

  it('recovers a report under the length floor', () => {
    expect(reportNeedsHierarchicalRecovery(candidate({ length: 2_000 }), 6, 1)).toBe(true)
  })

  it('recovers when the prompt could not carry the research, floors or no floors', () => {
    // Run 60, exactly: six cited blocks against six required and 3,768
    // characters against a 2,700 floor -- cleared both by the narrowest
    // possible margin -- while the packet held 5,725 of 56,528 characters of
    // verified evidence. It shipped 4,423 characters citing six blocks from 81
    // evidence items across 48 sources.
    const scrapedPast = candidate({ citedSubstantiveBlockCount: 6, length: 3_768 })

    expect(reportNeedsHierarchicalRecovery(scrapedPast, 6, 5_725 / 56_528)).toBe(true)
  })

  it('leaves a well-fed single-pass report alone', () => {
    // Runs 49, 50 and 51 saw 42.7%, 67.6% and 36.9% of their evidence and
    // shipped 24-28 cited blocks in 30,000-47,000 characters. Sending these
    // down the per-step path would roughly triple the runtime to rewrite a
    // report that was already good.
    for (const coverage of [0.369, 0.427, 0.676]) {
      expect(reportNeedsHierarchicalRecovery(candidate({}), 6, coverage)).toBe(false)
    }
  })

  it('does not divide evidence when there is only one step to divide it between', () => {
    // A single step gets the same packet either way, so the extra passes buy
    // nothing.
    expect(reportNeedsHierarchicalRecovery(candidate({}), 1, 0.01)).toBe(false)
  })

  it('treats a run holding no evidence as fully covered', () => {
    // The caller passes 1 when there is nothing to miss; nothing here should
    // read that as a starved prompt.
    expect(reportNeedsHierarchicalRecovery(candidate({}), 6, 1)).toBe(false)
  })
})
