import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { validateResearchReport } from './criticalThinkingEvidence'
import { validateReportContract } from './criticalThinkingReportContract'

/**
 * Deterministic, validation-led scoring for one synthesis draft — used to
 * decide whether a repair attempt should actually replace the original
 * (P0-F: previously any nonempty repair replaced the original unconditionally,
 * so a shorter, less complete repair could silently overwrite a better draft).
 */
export interface ReportCandidate {
  content: string
  overallValid: boolean
  issueCount: number
  /** Combined citation-safety and report-completeness issues, for the final user-facing message. */
  issues: string[]
  citedSubstantiveBlockCount: number
  length: number
}

export function evaluateReportCandidate(
  content: string,
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[],
  approvedStepCount: number
): ReportCandidate {
  const trimmed = content.trim()
  const citation = validateResearchReport(trimmed, artifacts, sources)
  const contract = validateReportContract(trimmed, approvedStepCount)
  return {
    content: trimmed,
    overallValid: citation.valid && contract.valid,
    issueCount: citation.issues.length + contract.issues.length,
    issues: [...citation.issues, ...contract.issues],
    citedSubstantiveBlockCount: contract.citedSubstantiveBlockCount,
    length: trimmed.length
  }
}

/**
 * Ordering: valid beats invalid; fewer safety/completeness issues beats more;
 * more cited substantive content beats less; only then does a longer draft
 * win the tie-break. Never picks a candidate solely because it is newer.
 * `original` wins every tie so an empty or no-better repair never displaces it.
 */
export function chooseBetterReportCandidate(
  original: ReportCandidate,
  repaired: ReportCandidate
): ReportCandidate {
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
