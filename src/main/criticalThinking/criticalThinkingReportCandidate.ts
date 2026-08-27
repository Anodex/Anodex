import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { normalizeCitationMarkers, validateResearchReport } from './criticalThinkingEvidence'
import { validateReportContract } from './criticalThinkingReportContract'

/**
 * Deterministic, validation-led scoring for one synthesis draft — used to
 * decide whether a repair attempt should actually replace the original
 * (P0-F: previously any nonempty repair replaced the original unconditionally,
 * so a shorter, less complete repair could silently overwrite a better draft)
 * and whether the deterministic fallback is even needed.
 */
export interface ReportCandidate {
  content: string
  overallValid: boolean
  /**
   * No fabrication: every citation resolves to a fetched source, and every
   * quote/number/chart value matches its cited evidence (see
   * `validateResearchReport`'s `safetyIssues`). A report can be `safe` without
   * being `overallValid` — it may just miss a section heading or leave a
   * framing sentence uncited, which is imperfect but not false.
   */
  safe: boolean
  /**
   * Good enough to show to the user in place of the deterministic fallback:
   * `safe` AND carries at least the contract's floor of cited substantive
   * blocks. A safe, substantial report that's merely imperfectly structured
   * beats a blunt-but-valid fallback; an unsafe or threadbare draft does not.
   */
  usable: boolean
  issueCount: number
  /** Combined citation-safety and report-completeness issues, for the final user-facing message. */
  issues: string[]
  citedSubstantiveBlockCount: number
  length: number
}

/** Mirrors `validateReportContract`'s cited-block floor: mildly scales with plan size. */
function minimumCitedBlocks(approvedStepCount: number): number {
  return Math.max(1, Math.min(3, approvedStepCount))
}

/**
 * How much text may be discarded as preamble. Narration on the way to a report
 * is a sentence or three; a response carrying more than this before its title
 * is not a report with a preface, and keeping only its tail would lose more
 * than it cleaned up.
 */
const MAX_PREAMBLE_CHARS = 2_000

/**
 * Drop what the model wrote on its way to the report.
 *
 * A repair pass routinely narrates before it produces anything: "I'll repair
 * the report by checking each flagged quote against the evidence packet", then
 * "Here is the complete repaired report:", then the report. All of it was
 * scored as report text, so the narration itself failed the contract for
 * carrying no citation -- three fresh issues on top of the ones being repaired.
 * Measured on a real run, a repair scored 18 issues against the draft's 14 and
 * lost, purely on its own preface, so repair could not improve anything.
 *
 * A report always opens with its title -- the contract requires one and reports
 * it missing -- so anything before the first top-level heading is preface by
 * construction.
 */
function withoutModelPreamble(content: string): string {
  const heading = /^\s{0,3}#\s+\S/m.exec(content)
  if (!heading || heading.index === 0) return content
  if (!content.slice(0, heading.index).trim()) return content.slice(heading.index)
  if (heading.index > MAX_PREAMBLE_CHARS) return content
  return content.slice(heading.index)
}

export function evaluateReportCandidate(
  content: string,
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[],
  approvedStepCount: number
): ReportCandidate {
  // Normalized before anything reads it, so the validators and the renderer
  // see the same markers the stored report will carry.
  const trimmed = normalizeCitationMarkers(withoutModelPreamble(content).trim())
  const citation = validateResearchReport(trimmed, artifacts, sources)
  const contract = validateReportContract(trimmed, approvedStepCount)
  const safe = citation.safetyIssues.length === 0
  return {
    content: trimmed,
    overallValid: citation.valid && contract.valid,
    safe,
    usable: safe && contract.citedSubstantiveBlockCount >= minimumCitedBlocks(approvedStepCount),
    issueCount: citation.issues.length + contract.issues.length,
    issues: [...citation.issues, ...contract.issues],
    citedSubstantiveBlockCount: contract.citedSubstantiveBlockCount,
    length: trimmed.length
  }
}

/**
 * Ordering: a `usable` (safe, substantial) draft beats an unusable one — this
 * is what keeps a fabricating or threadbare repair, and the blunt deterministic
 * fallback, from displacing a good model report. Only then: valid beats
 * invalid; fewer issues beats more; more cited substantive content beats less;
 * finally a longer draft wins. `original` wins every genuine tie so an empty or
 * no-better repair never displaces it.
 */
export function chooseBetterReportCandidate(
  original: ReportCandidate,
  repaired: ReportCandidate
): ReportCandidate {
  if (original.usable !== repaired.usable) {
    return original.usable ? original : repaired
  }
  if (original.overallValid !== repaired.overallValid) {
    return original.overallValid ? original : repaired
  }
  if (original.issueCount !== repaired.issueCount) {
    return original.issueCount < repaired.issueCount ? original : repaired
  }
  if (original.citedSubstantiveBlockCount !== repaired.citedSubstantiveBlockCount) {
    return original.citedSubstantiveBlockCount > repaired.citedSubstantiveBlockCount
      ? original
      : repaired
  }
  return repaired.length > original.length ? repaired : original
}
