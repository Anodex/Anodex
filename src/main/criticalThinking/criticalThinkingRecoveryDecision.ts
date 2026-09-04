import type { ReportCandidate } from './criticalThinkingReportCandidate'

/**
 * Share of the run's verified evidence a single-pass prompt must be able to
 * carry before its report is taken at face value.
 *
 * Below this, the one-shot report is not a judgement about the research -- it
 * is a report written from a fraction of it. Hierarchical recovery gives each
 * step its own packet, so the same context shows the model several times more
 * evidence in total.
 *
 * Measured across the stored runs, packet characters over verified passage
 * characters:
 *
 *   49  42.7%  single-pass  25 cited  47,549 chars
 *   50  67.6%  single-pass  24 cited  30,143 chars
 *   51  36.9%  single-pass  28 cited  35,161 chars
 *   60  10.1%  single-pass   6 cited   4,423 chars
 *   55   6.5%  hierarchical 30 cited  37,501 chars
 *   56   6.4%  hierarchical 31 cited  38,093 chars
 *
 * Every run that did well on one pass saw at least 36.9%; the starved one saw
 * 10.1%. Runs 55 and 56 hold the comparison still: near-identical evidence to
 * run 60 and the same 8K window, and taking the per-step path they shipped five
 * times the cited coverage and eight times the length.
 *
 * A quarter sits in the middle of a 26-point gap in the data rather than on
 * either edge, so it separates the observed cases without being fitted to them.
 * It is a coverage test, not a quality bar: nothing here asks whether a report
 * is good, only whether the prompt that produced it could have seen the
 * research.
 */
const MINIMUM_SINGLE_PASS_EVIDENCE_COVERAGE = 0.25

/**
 * Whether to rebuild the report one step at a time instead of accepting the
 * single-pass attempt.
 *
 * The first two conditions are unchanged: an unusable report always recovers,
 * and so does one that cites less than once per researched step or comes in
 * under a length floor.
 *
 * The third is new, and it exists because those floors are minimums being read
 * as sufficiency. Run 60 cleared them by the narrowest possible margin -- six
 * cited blocks against six required, 3,768 characters against 2,700 -- and
 * shipped 4,423 characters citing six blocks, from 81 evidence items across 48
 * sources. It had gathered the research and then shown the model a tenth of it.
 *
 * `evidenceCoverage` is `packetChars / verifiedEvidenceChars`, or 1 when there
 * is no evidence to miss.
 */
export function reportNeedsHierarchicalRecovery(
  candidate: ReportCandidate,
  stepsWithEvidence: number,
  evidenceCoverage: number
): boolean {
  if (!candidate.usable) return true
  const expectedCitedBlocks = Math.max(1, stepsWithEvidence)
  const minimumDetailedChars = Math.max(1_200, stepsWithEvidence * 450)
  if (
    candidate.citedSubstantiveBlockCount < expectedCitedBlocks ||
    candidate.length < minimumDetailedChars
  ) {
    return true
  }
  // Only worth the extra passes when there are steps to divide the evidence
  // between; one step gets the same single packet either way.
  return stepsWithEvidence > 1 && evidenceCoverage < MINIMUM_SINGLE_PASS_EVIDENCE_COVERAGE
}
