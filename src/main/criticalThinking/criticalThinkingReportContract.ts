/**
 * Report-completeness contract, kept separate from `validateResearchReport`'s
 * citation/quote/number/URL safety checks (criticalThinkingEvidence.ts) — a
 * short report with one valid citation currently passes citation validation
 * even though it never answers the question. This is a distinct concern:
 * does the report have the sections and substantive, cited content a
 * completed or honestly-partial investigation should produce, regardless of
 * whether every citation it does contain is safe.
 */

export interface ReportContractResult {
  valid: boolean
  issues: string[]
  substantiveBlockCount: number
  citedSubstantiveBlockCount: number
}

/**
 * Two structural signals a complete report must carry, matched by keyword
 * anywhere in a heading line (not just at its start) so a real model report
 * organized as "## 1. Pain Intensity" with an "### 2.2 Evidence Gaps"
 * subsection and an "## Executive Summary" is recognized — the exact live
 * report that was wrongly marked "missing 4 sections" and demoted for the
 * blunt fallback.
 *
 * `findings` and `sources` are deliberately NOT required as named headings:
 * the cited-substantive-block floor below already guarantees the report has
 * real findings content, and inline `[[S#:P#]]` citations already provide
 * source traceability (Anodex renders a separate sources view from them), so
 * demanding literal "## Findings"/"## Sources" headings only rejected
 * well-structured reports that organize their evidence differently.
 */
const REQUIRED_SECTIONS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'a limits, gaps, or open-questions section',
    pattern:
      /^#{1,6}[^\n]*\b(limits?|limitations?|open questions?|uncertaint\w*|gaps?|caveats?|not investigated|unresolved)\b/im
  },
  {
    // A closing conclusion/recommendations OR a leading executive summary
    // both satisfy this — a research report summarized up front does not also
    // need a redundant closing section.
    name: 'a summary or conclusion section',
    pattern: /^#{1,6}[^\n]*\b(summary|conclusion|bottom line|recommendations?|takeaways?)\b/im
  }
]

const MIN_SUBSTANTIVE_WORDS = 5
const CITATION_PATTERN = /\[\[S\d+(?::P\d+)?\]\]/

/**
 * Checks structural/coverage completeness only. Citation safety (unknown
 * sources, unsupported quotes/numbers/chart values, raw URLs) remains
 * `validateResearchReport`'s job — a report can fail here while passing
 * there, and vice versa; both must pass before a run is Complete.
 */
export function validateReportContract(
  report: string,
  approvedStepCount: number
): ReportContractResult {
  const issues: string[] = []
  const trimmed = report.trim()
  if (!trimmed) {
    return {
      valid: false,
      issues: ['The report is empty.'],
      substantiveBlockCount: 0,
      citedSubstantiveBlockCount: 0
    }
  }
  if (!/^#{1,6}\s*\S/m.test(trimmed)) {
    issues.push('The report has no descriptive title.')
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!section.pattern.test(trimmed)) issues.push(`The report is missing ${section.name}.`)
  }

  const withoutCode = trimmed.replace(/```[\s\S]*?```/g, '')
  const blocks = withoutCode
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !/^#{1,6}\s/.test(block) && !/^[-*_]{3,}$/.test(block))
  const substantiveBlocks = blocks.filter((block) => countWords(block) >= MIN_SUBSTANTIVE_WORDS)
  const citedSubstantiveBlocks = substantiveBlocks.filter((block) => CITATION_PATTERN.test(block))

  if (substantiveBlocks.length === 0) {
    issues.push('The report has no substantive findings text.')
  } else {
    // A report investigating several plan steps that only ever produces one
    // cited paragraph is the exact shape of the reproduced 175-character
    // failure — require the cited substance to scale (mildly) with plan size
    // instead of a single fixed threshold that a trivial report can clear.
    const minimumCitedBlocks = Math.max(1, Math.min(3, approvedStepCount))
    if (citedSubstantiveBlocks.length < minimumCitedBlocks) {
      issues.push(
        `The report has only ${citedSubstantiveBlocks.length} cited substantive block(s); ` +
          `at least ${minimumCitedBlocks} are expected for ${approvedStepCount} researched step(s).`
      )
    }
  }

  const lastProseLine = withoutCode
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[-*_]{3,}$/.test(line))
    .at(-1)
  const looksLikeUnfinishedProse =
    lastProseLine !== undefined &&
    countWords(lastProseLine) >= MIN_SUBSTANTIVE_WORDS &&
    !/^#{1,6}\s/.test(lastProseLine) &&
    !/[-*]\s/.test(lastProseLine.slice(0, 2)) &&
    !/[.!?"'’”)\]]\s*$/.test(lastProseLine)
  if (!lastProseLine || /^#{1,6}\s*$/.test(lastProseLine) || looksLikeUnfinishedProse) {
    issues.push('The report ends on an unfinished heading or sentence.')
  }

  return {
    valid: issues.length === 0,
    issues,
    substantiveBlockCount: substantiveBlocks.length,
    citedSubstantiveBlockCount: citedSubstantiveBlocks.length
  }
}

function countWords(text: string): number {
  const words = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\[S\d+(?::P\d+)?\]\]/g, ' ')
    .replace(/[^\p{L}\p{N}'’-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return words.length
}
