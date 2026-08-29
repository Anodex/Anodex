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
  /**
   * The report carries the sections the contract requires. Separate from
   * `overallValid`, which also demands complete citation coverage: a report can
   * be structurally whole and still leave a lead-in line uncited.
   */
  structurallyValid: boolean
  /**
   * Quotations the evidence could not confirm. Kept apart from the rest of the
   * safety issues because they are disclosable: the report says what it could
   * not trace and the reader is told, rather than the whole report being
   * replaced by one that says less. See `unverifiedQuotationsTolerated`.
   */
  unverifiedQuotations: string[]
  /**
   * Figures the evidence could not account for, after the checks that tell a
   * misplaced citation from an invention have run. Kept apart for the same
   * reason as quotations — they are disclosable — but on a far shorter leash,
   * since a figure cannot be neutralised the way a quotation can.
   */
  unverifiedFigures: string[]
  /** The same quotations as exact report text, for locating and acting on them. */
  unverifiedQuotationText: string[]
  /**
   * Safety issues that are neither disclosable quotations nor disclosable
   * figures — an invented citation, an unfetched source, a malformed chart.
   * Any one of these alone makes a report unusable, so recording the count is
   * what lets a `partial` verdict name its own cause.
   */
  otherSafetyIssues: string[]
  /**
   * Which of `usable`'s conditions failed, named by this module because this is
   * where the thresholds live. Empty when the candidate is usable.
   */
  usableBlockers: string[]
  issueCount: number
  /** Combined citation-safety and report-completeness issues, for the final user-facing message. */
  issues: string[]
  /** The report-completeness issues alone, so a structural failure stays legible. */
  contractIssues: string[]
  citedSubstantiveBlockCount: number
  length: number
}

const UNVERIFIED_QUOTATION_PREFIX = 'Quoted text is not present'

/**
 * Share of a report's cited blocks that may carry an untraceable quotation
 * before the report stops being worth disclosing and starts being worth
 * refusing. A report quoting mostly text nobody can find is not a report with
 * some loose attributions.
 */
const MAX_UNVERIFIED_QUOTATION_SHARE = 0.5

/**
 * A figure the evidence cannot account for, after the checks that tell a
 * misplaced citation from an invention have already run.
 */
const UNVERIFIED_FIGURE_PREFIXES = ['Numeric claim', 'Chart value']

/**
 * How many untraceable figures a report may carry and still be worth shipping.
 *
 * Deliberately far tighter than the quotation allowance, and absolute rather
 * than a share. A quotation can be neutralised -- take the marks off and the
 * sentence becomes the report's own words, claiming nothing about a source. A
 * figure cannot: it stays in the text as an assertion either way, and the only
 * thing disclosure changes is whether the reader is told it is unverified. So
 * one or two is a report with a loose figure; more than that is a report whose
 * numbers cannot be trusted, and the reader is better served by the fallback.
 */
const MAX_UNVERIFIED_FIGURES = 2

function isUnverifiedQuotationIssue(issue: string): boolean {
  return issue.startsWith(UNVERIFIED_QUOTATION_PREFIX)
}

function isUnverifiedFigureIssue(issue: string): boolean {
  return (
    UNVERIFIED_FIGURE_PREFIXES.some((prefix) => issue.startsWith(prefix)) &&
    issue.includes('not present')
  )
}

function unverifiedQuotationsTolerated(count: number, citedBlockCount: number): boolean {
  if (count === 0) return true
  return count <= Math.ceil(Math.max(1, citedBlockCount) * MAX_UNVERIFIED_QUOTATION_SHARE)
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
  const unverifiedQuotations = citation.safetyIssues.filter(isUnverifiedQuotationIssue)
  const unverifiedFigures = citation.safetyIssues.filter(isUnverifiedFigureIssue)
  const otherSafetyIssues = citation.safetyIssues.filter(
    (issue) => !isUnverifiedQuotationIssue(issue) && !isUnverifiedFigureIssue(issue)
  )
  const safe = citation.safetyIssues.length === 0
  const usableBlockers: string[] = []
  if (otherSafetyIssues.length > 0) usableBlockers.push('other-safety-issues')
  if (unverifiedFigures.length > MAX_UNVERIFIED_FIGURES) {
    usableBlockers.push('too-many-unverified-figures')
  }
  if (
    !unverifiedQuotationsTolerated(unverifiedQuotations.length, contract.citedSubstantiveBlockCount)
  ) {
    usableBlockers.push('too-many-unverified-quotations')
  }
  if (contract.citedSubstantiveBlockCount < minimumCitedBlocks(approvedStepCount)) {
    usableBlockers.push('too-few-cited-blocks')
  }
  return {
    content: trimmed,
    overallValid: citation.valid && contract.valid,
    structurallyValid: contract.valid,
    safe,
    unverifiedQuotations,
    unverifiedFigures,
    unverifiedQuotationText: citation.unverifiedQuotationText,
    otherSafetyIssues,
    // Neither a handful of untraceable quotations nor one or two untraceable
    // figures costs the whole report any more. Both are disclosed in its limits
    // section, so the reader is told which words are the report's own rather
    // than a source's and which numbers the evidence could not account for.
    //
    // An invented citation still makes a report unusable, and so does one whose
    // quotations are mostly untraceable or whose figures run past a very short
    // allowance -- the alternative on offer is a report organised around the
    // research steps, which is worth having only when this one cannot be
    // trusted at all.
    usable: usableBlockers.length === 0,
    usableBlockers,
    issueCount: citation.issues.length + contract.issues.length,
    issues: [...citation.issues, ...contract.issues],
    contractIssues: contract.issues,
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

/** Heading a report uses for what its evidence could not settle. */
const LIMITS_HEADING =
  / {0,3}#{1,6}\s*(?:\d+[.)]?\s*)*(?:limits?|limitations?|open questions?|caveats?)\b/i

/**
 * Tell the reader which quotations could not be traced, in the report's own
 * limits section.
 *
 * A quotation the evidence cannot confirm used to cost the entire report: it
 * made the draft unsafe, and an assembled fallback that quotes nothing won
 * instead. Measured on a live run, that traded a report organised around the
 * user's question -- feature ranking, build tiers, a recommendation -- for one
 * organised around the research steps, carrying six blocks of raw excerpts.
 *
 * Disclosure keeps the analysis and keeps the reader informed, which is the
 * property that actually matters: nobody is told these are a source's words.
 */
export function discloseUnverifiedQuotations(
  content: string,
  issues: string[],
  figureIssues: string[] = []
): string {
  const quotations = issues.map(quotedTextFromIssue).filter((text): text is string => Boolean(text))
  const figures = [...new Set(figureIssues.map(figureFromIssue).filter(Boolean))]
  if (quotations.length === 0 && figures.length === 0) return content

  const sections: string[] = []
  if (quotations.length > 0) {
    sections.push(
      [
        '**Quotations that could not be matched to their cited source:**',
        '',
        ...[...new Set(quotations)].map((quotation) => `- “${quotation}”`),
        '',
        'Treat these as the report’s paraphrase, not as the source’s words.'
      ].join('\n')
    )
  }
  if (figures.length > 0) {
    // Named separately from the quotations because the reader has to do
    // something different with them: a quotation has already been stripped of
    // its marks, while a figure still stands in the text as an assertion.
    sections.push(
      [
        '**Figures the evidence could not account for:**',
        '',
        ...figures.map((figure) => `- ${figure}`),
        '',
        'These were not found in any page this investigation read. Check them before relying on them.'
      ].join('\n')
    )
  }
  const body = sections.join('\n\n')

  const lines = content.split('\n')
  const limitsAt = lines.findIndex((line) => LIMITS_HEADING.test(line))
  if (limitsAt < 0) {
    return `${content.trimEnd()}\n\n## Limits and Open Questions\n\n${body}\n`
  }

  // The limits section ends at the next heading of the same level or higher, so
  // the disclosure sits with the other limits rather than after the sources.
  const level = headingLevel(lines[limitsAt])
  let endAt = lines.length
  for (let index = limitsAt + 1; index < lines.length; index++) {
    const nextLevel = headingLevel(lines[index])
    if (nextLevel > 0 && nextLevel <= level) {
      endAt = index
      break
    }
  }

  const before = lines.slice(0, endAt).join('\n').trimEnd()
  const after = lines.slice(endAt).join('\n').trimStart()
  return after ? `${before}\n\n${body}\n\n${after}` : `${before}\n\n${body}\n`
}

/** Heading depth of a markdown line, or 0 when the line is not a heading. */
function headingLevel(line: string): number {
  return /^ {0,3}(#{1,6})\s/.exec(line)?.[1].length ?? 0
}

/** The figure out of an issue line such as "Numeric claim 32,000 is not present...". */
function figureFromIssue(issue: string): string | null {
  return /^(?:Numeric claim|Chart value)\s+(.+?)\s+is not present/.exec(issue)?.[1] ?? null
}

/** The quoted text out of an issue line, which wraps it in curly quotes. */
function quotedTextFromIssue(issue: string): string | null {
  const match = /“([\s\S]*)”\s*$/.exec(issue)
  return match ? match[1] : null
}

/**
 * Take the quotation marks off text the evidence could not confirm.
 *
 * A local model writes some quotations from memory rather than from the packet
 * in front of it. Traced on a live run, six of nine flagged quotations appeared
 * in none of that run's passages, findings, plan or question -- they were
 * recalled marketing and review copy, dressed as quotation. No prompt fixes
 * that: the model believes it is quoting.
 *
 * So the marks come off deterministically. The sentence keeps its text and its
 * citation and becomes the report's own paraphrase, which is what it always
 * was; what disappears is the claim that a source used those words. That is the
 * property worth defending, and defending it this way costs none of the
 * analysis -- the alternative was discarding the whole report and shipping a
 * log of research steps instead.
 */
export function neutraliseUnverifiedQuotations(content: string, quotations: string[]): string {
  let result = content
  for (const quotation of quotations) {
    for (const [open, close] of [
      ['“', '”'],
      ['"', '"']
    ]) {
      const marked = `${open}${quotation}${close}`
      // Split/join rather than a regex: a quotation is arbitrary text and may
      // carry regex metacharacters.
      if (result.includes(marked)) result = result.split(marked).join(quotation)
    }
  }
  return result
}
