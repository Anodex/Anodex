import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { EvidencePassage, ToolArtifact } from '@shared/toolArtifacts.types'
import {
  criticalThinkingSourceAuthorityScore,
  criticalThinkingSourceClass,
  isWeakCriticalThinkingSource
} from './criticalThinkingSourceAuthority'
import { canonicalResearchUrl } from './criticalThinkingUrl'

export interface ReportValidationResult {
  valid: boolean
  issues: string[]
  /**
   * The subset of `issues` that mean the report makes a claim NOT backed by
   * real fetched evidence — a citation to an unknown/unfetched source, a
   * quote/number/chart value that isn't in its cited passage, or a raw URL.
   * These are fabrication and must never be shown. The rest are coverage/
   * completeness gaps (uncited framing, an uncited number, no citation
   * markers) — the report is imperfect but not false, so a substantial,
   * safe-but-imperfect model report is preferable to the blunt deterministic
   * fallback (see `criticalThinkingReportCandidate.ts`).
   */
  safetyIssues: string[]
  /**
   * The exact text of each quotation the evidence could not confirm, untruncated
   * so a caller can find it in the report and act on it. `safetyIssues` carries
   * the same quotations as reader-facing messages, shortened for display, which
   * is no use for locating the original.
   */
  unverifiedQuotationText: string[]
}

/** Routes each validation issue to fabrication ("safety") vs completeness ("coverage"). */
interface IssueCollector {
  safety: string[]
  coverage: string[]
}

const MIN_INITIAL_PASSAGE_TEXT_CHARS = 32
const MAX_EXTRA_PASSAGE_LINE_CHARS = 360

/**
 * Rewrite the compound citation forms a model reaches for into the single
 * `[[S1]]` / `[[S1:P2]]` markers every validator and renderer in this module
 * recognizes: ranges (`[[S9:P1-S9:P2]]`, `[[S9:P1-P3]]`) and lists
 * (`[[S1, S2]]`, `[[S1:P1; S1:P2]]`).
 *
 * Observed live: a report cited `[[S9:P1-S9:P2]]`. Because that shape matches
 * none of the marker patterns, it was simultaneously invisible three ways —
 * it rendered as literal `[[S9:P1-S9:P2]]` in the finished report, its source
 * id was never checked against fetched evidence (a citation-safety hole, the
 * one class of issue that must never pass), and the paragraph around it
 * counted as UNCITED, pushing a properly-sourced report toward the
 * deterministic fallback.
 *
 * A range is expanded to its endpoints rather than every passage between
 * them: the endpoints are what the model actually named, and inventing the
 * interior would be asserting citations it never wrote. Anything that still
 * does not parse is left untouched so it stays visible as a defect instead of
 * being silently deleted.
 */
export function normalizeCitationMarkers(report: string): string {
  return report.replace(/\[\[([^\]\n]{1,120})\]\]/g, (marker, body: string) => {
    const parts = body
      .split(/\s*[,;]\s*|\s*[-–—]\s*/)
      .map((part) => part.trim())
      .filter(Boolean)
    // Single markers run through the same loop rather than returning early.
    // They are already canonical far more often than not, but `[[s1]]`,
    // `[[ S1]]` and `[[S1:p2]]` are not — and every regex downstream matches
    // uppercase with no padding, so each of those was invisible in exactly the
    // three ways the compound forms were: never checked against fetched
    // evidence, rendered as literal `[[s1]]`, and counted as UNCITED, which on
    // a report whose only citations slipped case reported "the report contains
    // no evidence citation markers" about a properly sourced draft.
    const expanded: string[] = []
    let currentSource = ''
    for (const part of parts) {
      const full = /^(S\d+):(P\d+)$/i.exec(part)
      if (full) {
        currentSource = full[1].toUpperCase()
        expanded.push(`[[${currentSource}:${full[2].toUpperCase()}]]`)
        continue
      }
      const sourceOnly = /^(S\d+)$/i.exec(part)
      if (sourceOnly) {
        currentSource = sourceOnly[1].toUpperCase()
        expanded.push(`[[${currentSource}]]`)
        continue
      }
      // A bare passage ("P3" in "[[S9:P1-P3]]") belongs to the source named
      // most recently, which is how the model wrote it.
      const passageOnly = /^(P\d+)$/i.exec(part)
      if (passageOnly && currentSource) {
        expanded.push(`[[${currentSource}:${passageOnly[1].toUpperCase()}]]`)
        continue
      }
      return marker
    }
    return [...new Set(expanded)].join(' ')
  })
}

/** Build a bounded, exact evidence packet; only fetched pages can support citations. */
export function buildEvidencePacket(
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[],
  maxChars = 36_000
): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0
  if (limit === 0) return ''
  const sourceByUrl = new Map(
    trustedVerifiedSources(sources).map((source) => [canonicalResearchUrl(source.url), source])
  )
  const passagesByUrl = fetchedPassagesByUrl(artifacts)
  const candidates = balancedFetchedUrls(artifacts, passagesByUrl, sourceByUrl).flatMap((url) => {
    const source = sourceByUrl.get(url)
    if (!source?.verified) return []
    const passages = passagesByUrl.get(url) ?? []
    return [
      {
        header: `[${source.id}] ${source.title}\nEvidence class: ${criticalThinkingSourceClass(source.url, source.title)}\nURL: ${source.url}`,
        compactHeader: `[${source.id}] ${source.title}\nURL: ${source.url}`,
        passageLines: passages.map((passage) => `[${source.id}:${passage.id}] ${passage.text}`)
      }
    ]
  })
  const selected: Array<{
    header: string
    compactHeader: string
    passageLines: string[]
    minimumFirstLine: string
    minimumLength: number
  }> = []
  let minimumUsed = 0
  for (const candidate of candidates) {
    const firstPassage = candidate.passageLines[0]
    const minimumFirstLine = firstPassage ? minimumEvidenceLine(firstPassage) : null
    if (!minimumFirstLine) continue
    const separator = selected.length > 0 ? 2 : 0
    const fullMinimumLength = candidate.header.length + minimumFirstLine.length + 1
    const header =
      minimumUsed + separator + fullMinimumLength <= limit
        ? candidate.header
        : candidate.compactHeader
    const minimumLength = header.length + minimumFirstLine.length + 1
    if (minimumUsed + separator + minimumLength > limit) continue
    selected.push({ ...candidate, header, minimumFirstLine, minimumLength })
    minimumUsed += separator + minimumLength
  }
  if (selected.length === 0) return ''

  // First reserve one useful passage for as many step-balanced sources as fit.
  // Divide spare space equally so a large source list can never reduce every
  // source below its viable minimum and accidentally produce an empty packet.
  const extraShare = Math.floor((limit - minimumUsed) / selected.length)
  const sections: Array<{ lines: string[]; remaining: string[] }> = []
  let used = 0
  for (const candidate of selected) {
    const sectionLimit = candidate.minimumLength + extraShare
    const initial = fitInitialEvidenceSection(
      candidate.header,
      candidate.passageLines[0],
      sectionLimit
    )
    if (!initial) continue
    const separator = sections.length > 0 ? 2 : 0
    sections.push({ lines: initial.lines, remaining: candidate.passageLines.slice(1) })
    used += separator + initial.length
  }

  // Spend any unused space on later passages in round-robin order.
  let addedPassage = true
  while (addedPassage && used < limit) {
    addedPassage = false
    for (const section of sections) {
      const line = section.remaining.shift()
      if (!line) continue
      const remaining = Math.min(MAX_EXTRA_PASSAGE_LINE_CHARS, limit - used - 1)
      if (remaining <= 0) break
      const accepted = fitEvidenceLine(line, remaining)
      if (!accepted) continue
      section.lines.push(accepted)
      used += accepted.length + 1
      addedPassage = true
      if (accepted.length < line.length) section.remaining.length = 0
      if (used >= limit) break
    }
  }

  return sections.map((section) => section.lines.join('\n')).join('\n\n')
}

function minimumEvidenceLine(line: string): string | null {
  const markerEnd = line.indexOf('] ') + 2
  if (markerEnd <= 1) return null
  return line.slice(0, Math.min(line.length, markerEnd + MIN_INITIAL_PASSAGE_TEXT_CHARS))
}

function balancedFetchedUrls(
  artifacts: ToolArtifact[],
  passagesByUrl: Map<string, EvidencePassage[]>,
  sourceByUrl: Map<string, CriticalThinkingSource>
): string[] {
  const stepByUrl = new Map<string, string>()
  for (const artifact of artifacts) {
    if (artifact.kind !== 'web-fetch' || !artifact.research) continue
    const key = canonicalResearchUrl(artifact.finalUrl)
    if (!stepByUrl.has(key)) stepByUrl.set(key, artifact.research.stepId)
  }

  const groups = new Map<string, string[]>()
  for (const url of passagesByUrl.keys()) {
    const group = stepByUrl.get(url) ?? '__legacy__'
    const urls = groups.get(group) ?? []
    urls.push(url)
    groups.set(group, urls)
  }
  for (const urls of groups.values()) {
    urls.sort((left, right) => {
      const leftSource = sourceByUrl.get(left)
      const rightSource = sourceByUrl.get(right)
      return (
        criticalThinkingSourceAuthorityScore(rightSource?.url ?? right, rightSource?.title ?? '') -
        criticalThinkingSourceAuthorityScore(leftSource?.url ?? left, leftSource?.title ?? '')
      )
    })
  }

  const ordered: string[] = []
  let found = true
  for (let index = 0; found; index += 1) {
    found = false
    for (const urls of groups.values()) {
      const url = urls[index]
      if (!url) continue
      ordered.push(url)
      found = true
    }
  }
  return ordered
}

function fitInitialEvidenceSection(
  header: string,
  passageLine: string,
  limit: number
): { lines: string[]; length: number } | null {
  const passageBudget = limit - header.length - 1
  const accepted = fitEvidenceLine(passageLine, passageBudget)
  return accepted
    ? { lines: [header, accepted], length: header.length + accepted.length + 1 }
    : null
}

/**
 * Shortest run either side of an elision that still identifies its source. Long
 * enough that "the" or "of course" cannot bridge a fabricated quotation.
 */
const MIN_ELISION_FRAGMENT_CHARS = 12

/**
 * Whether a quotation appears in a passage, honouring the two marks careful
 * writers use when quoting: `…` for text left out, and `[]` for a word altered
 * to fit the sentence around it.
 *
 * Exact substring matching rejected both. A real report was faulted for
 * `freeze[s] the entire planet` and `at first intimidating amount of… options`
 * -- correctly marked edits of text that was genuinely in the sources. Careful
 * quoting was treated as fabrication, which is precisely backwards.
 *
 * An elision still has to be honest: every fragment must appear in the same
 * passage, in the order written, so the mark can shorten a quotation but cannot
 * stitch one together from unrelated places.
 */
function quotationAppearsIn(quote: string, passage: string): boolean {
  return quotationVariants(quote).some(
    (variant) =>
      appearsAcrossElisions(variant, passage) ||
      appearsAcrossElisions(withoutTrailingSentencePunctuation(variant), passage)
  )
}

/**
 * Drop punctuation that belongs to the quoting sentence rather than the source.
 *
 * The dominant English convention puts a comma or period inside the closing
 * quotation mark, so a quotation ending a clause carries punctuation the source
 * does not have. Exact matching then failed a correct quotation on a character
 * the writer was required to put there -- observed live on
 * `"dynamically responds to your window size,"`,
 * `"Create copy of included simulations,"` and
 * `"individualise each section,"` in one report.
 *
 * Only trailing punctuation is dropped, and only for the retry: a quotation
 * whose text genuinely differs from the source still fails.
 */
function withoutTrailingSentencePunctuation(quote: string): string {
  return quote.replace(/[\s,.;:!?]+$/, '')
}

/** `[s]` means the source reads either with that fragment or without it. */
function quotationVariants(quote: string): string[] {
  if (!quote.includes('[')) return [quote]
  return [quote, quote.replace(/\[[^\]]*\]/g, ''), quote.replace(/\[([^\]]*)\]/g, '$1')]
}

function appearsAcrossElisions(quote: string, passage: string): boolean {
  const fragments = quote
    .split(/\s*(?:…|\.\.\.)\s*/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= MIN_ELISION_FRAGMENT_CHARS)
  if (fragments.length === 0) return passage.includes(quote)
  let cursor = 0
  for (const fragment of fragments) {
    const at = passage.indexOf(fragment, cursor)
    if (at < 0) return false
    cursor = at + fragment.length
  }
  return true
}

/**
 * Shortest run of quoted text worth checking against the evidence. Below this,
 * a quotation is a word or a phrase whose appearance in the sources is not
 * meaningful and whose absence is not evidence of anything.
 */
const MIN_VERIFIABLE_QUOTE_CHARS = 20

/**
 * The quotations in a block, paired in the order they appear.
 *
 * A straight `"` is both an opening and a closing mark, so no single regular
 * expression can tell them apart locally. The previous pattern could not, and
 * the consequence was severe: when a quotation was shorter than the length
 * floor it was skipped, and its *closing* quote was then free to open a match
 * that ran to the next quotation's opening one. What got checked was the prose
 * between two quotations.
 *
 * Measured on a real report, that produced "quotes" like
 * `" here. I should soften this claim. Actually, the task says "` -- ordinary
 * sentences, markdown table pipes and citation markers swept up as if quoted.
 * None of it was in any source, because none of it was ever a quotation, and
 * the run rejected a sound 25,458-character report over 21 such phantoms before
 * falling back to dumping raw excerpts.
 *
 * Scanning left to right and pairing each opening mark with the next matching
 * closing one removes the ambiguity: a mark that closes a quotation cannot also
 * open the next. Newlines are deliberately allowed inside a span, since a
 * markdown block quote is the ordinary way to present a multi-line quotation.
 * An unterminated quotation yields nothing -- there is no span to check.
 */
function quotedSpans(block: string): string[] {
  const spans: string[] = []
  let openedAt = -1
  let openedWith = ''
  for (let index = 0; index < block.length; index++) {
    const character = block[index]
    if (openedAt >= 0) {
      if (openedWith === '“' ? character === '”' : character === '"') {
        spans.push(block.slice(openedAt + 1, index))
        openedAt = -1
      }
      continue
    }
    if (character === '“' || character === '"') {
      openedAt = index
      openedWith = character
    }
  }
  return spans
}

function fitEvidenceLine(line: string, limit: number): string | null {
  if (line.length <= limit) return line
  const markerEnd = line.indexOf('] ') + 2
  return markerEnd > 1 && limit >= markerEnd + 32 ? line.slice(0, limit) : null
}

export function validateResearchReport(
  report: string,
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[]
): ReportValidationResult {
  const collector: IssueCollector = { safety: [], coverage: [] }
  const unverifiedQuotationText: string[] = []
  const sourceById = new Map(trustedVerifiedSources(sources).map((source) => [source.id, source]))
  const passagesByUrl = fetchedPassagesByUrl(artifacts)
  const citations = [...report.matchAll(/\[\[(S\d+)(?::(P\d+))?\]\]/g)]
  const citationIds = citations.map((match) => match[1])
  for (const id of new Set(citationIds)) {
    if (!sourceById.has(id)) collector.safety.push(`Unknown or unfetched citation ${id}.`)
  }
  for (const citation of citations) {
    const source = sourceById.get(citation[1])
    const passages = source ? passagesByUrl.get(canonicalResearchUrl(source.url)) : undefined
    if (source && !passages?.length) {
      collector.safety.push(`Citation ${citation[1]} has no fetched evidence passages.`)
    } else if (citation[2] && !passages?.some((passage) => passage.id === citation[2])) {
      collector.safety.push(`Unknown evidence passage ${citation[1]}:${citation[2]}.`)
    }
  }

  for (const match of report.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    const rawUrl = match[0].replace(/[.,;:!?]+$/, '')
    if (!passagesByUrl.has(canonicalResearchUrl(rawUrl))) {
      collector.safety.push(`Raw URL is not backed by fetched evidence: ${rawUrl}`)
    } else {
      // Coverage, not safety. Reaching this branch has just established that
      // the URL *is* a page this run fetched, which is the opposite of the
      // "claim not backed by real fetched evidence" that `safetyIssues` is
      // defined as. Classifying it as fabrication threw away otherwise sound
      // reports over a formatting preference — the model wrote the link out
      // instead of a marker, having cited the same page correctly elsewhere.
      collector.coverage.push(`Use an internal citation marker instead of a raw URL: ${rawUrl}`)
    }
  }

  const proseReport = report.replace(/```[\s\S]*?```/g, '')
  const proseBlocks = proseReport.split(/\n{2,}/)
  proseBlocks.forEach((block, index) => {
    const own = passagesForCitations(block, passagesByUrl, sourceById).map(normalizeQuote)
    // A pulled-out quotation is its own block and routinely carries no marker
    // of its own — the attribution sits in the sentence that introduced it, one
    // block earlier, which is how a reader resolves it too. Only the block
    // immediately before, and only when this one cites nothing itself, so an
    // uncited quotation still cannot borrow evidence from an arbitrary
    // distance.
    const citedPassages =
      own.length > 0
        ? own
        : passagesForCitations(proseBlocks[index - 1] ?? '', passagesByUrl, sourceById).map(
            normalizeQuote
          )
    // Quotes may span lines. Excluding `\n` from the class meant a fabricated
    // quote written as a markdown block quote — the ordinary way to present one
    // — was matched by nothing and checked against nothing, so the single class
    // of issue this module promises never to let through had a bypass anyone
    // would hit by accident. Blocks are split on blank lines and the class
    // cannot cross a quote character, so a match still cannot run past the
    // quotation it belongs to.
    for (const raw of quotedSpans(block)) {
      if (raw.length < MIN_VERIFIABLE_QUOTE_CHARS) continue
      const quote = normalizeQuote(stripBlockQuoteMarkers(raw))
      if (citedPassages.some((passage) => quotationAppearsIn(quote, passage))) continue
      // The text may still be on the cited page, under a different passage
      // marker. That is a citation pointing a line or two off, not a quotation
      // of something nobody wrote -- and reporting the two the same way buried
      // the ones that mattered.
      const wholeSourceText = passagesForCitations(block, passagesByUrl, sourceById, true).map(
        normalizeQuote
      )
      if (wholeSourceText.some((passage) => quotationAppearsIn(quote, passage))) {
        collector.coverage.push(
          `Quotation is on the cited page but under a different passage marker: “${truncateIssue(raw).slice(0, 80)}”`
        )
        continue
      }
      unverifiedQuotationText.push(raw)
      collector.safety.push(
        `Quoted text is not present in its cited fetched passages: “${truncateIssue(raw).slice(0, 80)}”`
      )
    }
  })

  const exempt = uncitableBlocks(proseReport)
  validateCitationCoverage(proseReport, collector, exempt)
  validateSourceQualityCoverage(proseReport, sourceById, collector)
  validateCharts(report, passagesByUrl, sourceById, collector)
  validateNumericClaims(proseReport, passagesByUrl, sourceById, collector, exempt)
  if (citationIds.length === 0) {
    collector.coverage.push('The report contains no evidence citation markers.')
  }
  const safetyIssues = [...new Set(collector.safety)]
  const issues = [...new Set([...collector.safety, ...collector.coverage])]
  return { valid: issues.length === 0, issues, safetyIssues, unverifiedQuotationText }
}

function validateNumericClaims(
  report: string,
  passagesByUrl: Map<string, EvidencePassage[]>,
  sourceById: Map<string, CriticalThinkingSource>,
  collector: IssueCollector,
  exempt: Set<string>
): void {
  // Every passage the run fetched, joined once. Built lazily because most
  // reports never need it — only a figure that failed both the cited passage
  // and the cited page gets this far.
  let fetchedText: string | undefined
  const allFetchedText = (): string => {
    fetchedText ??= [...passagesByUrl.values()]
      .flatMap((passages) => passages.map((passage) => passage.text))
      .join(' \n ')
    return fetchedText
  }
  for (const paragraph of report.split(/\n{2,}/)) {
    const citations = [...paragraph.matchAll(/\[\[(S\d+)(?::(P\d+))?\]\]/g)]
    // Strip citation markers and structural outline numbering ("1.1", "2.3")
    // before scanning for data: a numbered section heading is not a numeric
    // claim, and treating it as one produced a wall of false "Numeric claim
    // 1.1 has no evidence citation" against a genuinely well-cited report.
    const claimText = withoutStructuralNumbering(paragraph.replace(/\[\[S\d+(?::P\d+)?\]\]/g, ''))
    const numbers = extractNumbers(claimText)
    if (citations.length === 0) {
      // Coverage only, and never for a section whose subject is what the
      // evidence does NOT cover — a limits line naming a step called
      // "…allocations for 2024-2026" is not making a numeric claim.
      if (exempt.has(paragraph.trim())) continue
      for (const number of numbers) {
        if (number.length === 1 && !number.endsWith('%')) continue
        collector.coverage.push(`Numeric claim ${number} has no evidence citation.`)
      }
      continue
    }
    for (const number of numbers) {
      if (number.length === 1 && !number.endsWith('%')) continue
      const evidenceText = passagesForCitations(paragraph, passagesByUrl, sourceById).join(' ')
      if (numberAppears(evidenceText, number)) continue
      // A small bare integer cannot be checked in either direction: "12" occurs
      // in almost any page, so finding it proves nothing and not finding it in
      // one passage disproves nothing. Calling that fabrication is a claim this
      // check cannot support.
      //
      // Measured across the stored runs: of 16 figures reported as fabricated,
      // 14 were present in the run's own evidence, and every false one was a
      // bare integer below the threshold -- 11 through 17, 35, 36. Each cost
      // the whole report, because one safety issue makes a draft unusable and
      // hands the run to its fallback.
      if (!isVerifiableFigure(number)) {
        collector.coverage.push(
          `Numeric claim ${number} could not be checked against the cited evidence.`
        )
        continue
      }
      // Same distinction the quotation check makes: a figure that is on the
      // cited page but under a different passage marker is a citation pointing
      // a line or two off, not an invented number. Measured on a live report,
      // two such years -- both verbatim in the presskit the run had fetched --
      // were reported as fabrication, and that alone made the report unusable
      // and sent the run to its fallback.
      const wholeSourceText = passagesForCitations(paragraph, passagesByUrl, sourceById, true).join(
        ' '
      )
      if (numberAppears(wholeSourceText, number)) {
        collector.coverage.push(
          `Numeric claim ${number} is on the cited page but under a different passage marker.`
        )
        continue
      }
      // Widened to everything the run fetched, not just the cited page. A
      // figure that reached this point is distinctive -- a unit, a decimal, or
      // three digits -- so finding it anywhere in the evidence is real proof
      // the model read it rather than invented it, and pointing at the wrong
      // page is a citation error, not a fabrication.
      //
      // Measured on a live run: of three figures reported as fabricated, the
      // price 29.99 and the year 2015 were both in the run's evidence under
      // other sources; only one was genuinely absent. Each of the two cost the
      // whole report.
      if (numberAppears(allFetchedText(), number)) {
        collector.coverage.push(`Numeric claim ${number} is cited to the wrong source.`)
        continue
      }
      collector.safety.push(`Numeric claim ${number} is not present in its cited evidence.`)
    }
  }
}

/**
 * Remove leading multi-level outline numbering ("1.1", "2.3.1", optionally
 * behind markdown heading/emphasis markers) from each line, so section numbers
 * are not mistaken for data claims. Only strips a leading token that has at
 * least one dot separator — a bare leading "30" (e.g. "30 minutes") or an
 * in-sentence number is left untouched.
 */
function withoutStructuralNumbering(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^[\s>#*_-]*\d+(?:\.\d+)+[.)]?\s+/, ''))
    .join('\n')
}

function passagesForCitations(
  text: string,
  passagesByUrl: Map<string, EvidencePassage[]>,
  sourceById: Map<string, CriticalThinkingSource>,
  /**
   * Ignore the passage number and take everything fetched from the cited page.
   *
   * Used only to tell two different mistakes apart. Quoting text that is on the
   * cited page but under a different passage marker is a citation that points a
   * line or two off; quoting text that is on no fetched page at all is the
   * model presenting its own words as a source's. Measured on a live report,
   * 3 of 16 flagged quotations were the first kind and 13 the second -- and
   * calling the first kind fabrication buried the ones that were.
   */
  wholeSource = false
): string[] {
  return [...text.matchAll(/\[\[(S\d+)(?::(P\d+))?\]\]/g)].flatMap((citation) => {
    const source = sourceById.get(citation[1])
    const passages = source ? passagesByUrl.get(canonicalResearchUrl(source.url)) : undefined
    return (passages ?? [])
      .filter((passage) => wholeSource || !citation[2] || passage.id === citation[2])
      .map((passage) => passage.text)
  })
}

/**
 * Locates the report's own "Sources" section, so its body can be replaced with
 * a generated reference list rather than left as a row of bare markers. Ends at
 * the next heading of the same or higher level — the section is not always last
 * (a "Conclusion" often follows it), so scanning to the end of the report would
 * swallow real content.
 */
function findSourcesSection(report: string): { start: number; end: number } | null {
  const heading = /^(#{1,6})[ \t]*sources[ \t]*$/im.exec(report)
  if (!heading) return null
  const level = heading[1].length
  const start = heading.index + heading[0].length
  const rest = report.slice(start)
  const next = new RegExp(`^#{1,${level}}[ \\t]+\\S`, 'm').exec(rest)
  return { start, end: next ? start + next.index : report.length }
}

/**
 * Convert validated internal IDs into clickable numbered references.
 *
 * Citations used to expand into the source's full page title — up to 160
 * characters — inline, mid-sentence. Because a handful of sources get cited
 * many times over, that made citation markup roughly 40% of a finished report
 * and turned dense passages into unreadable walls; a citation cluster between
 * two sentences could run longer than either sentence. Numbers carry the same
 * link and the same traceability at three characters, with the titles listed
 * once under "Sources".
 *
 * Numbering follows first appearance in the body, so a reader meeting [1] has
 * not yet seen [2]. The report's own Sources section is excluded from that scan
 * — it names every source and would otherwise fix the order before the prose
 * ever gets a say — and its body is then replaced with the generated list.
 */
export function renderResearchCitations(report: string, sources: CriticalThinkingSource[]): string {
  const sourceById = new Map(trustedVerifiedSources(sources).map((source) => [source.id, source]))
  const numbers = new Map<string, number>()
  const ordered: CriticalThinkingSource[] = []

  const numberFor = (sourceId: string): number | null => {
    const source = sourceById.get(sourceId)
    if (!source) return null
    const existing = numbers.get(sourceId)
    if (existing !== undefined) return existing
    const next = ordered.push(source)
    numbers.set(sourceId, next)
    return next
  }

  const renderBody = (text: string): string =>
    text
      .split(/(```[\s\S]*?```)/g)
      .map((block) => {
        if (block.startsWith('```chart')) return renderChartCitation(block, sourceById, numberFor)
        if (block.startsWith('```')) return block
        return block.replace(/\[\[(S\d+)(?::(P\d+))?\]\]/g, (marker, sourceId: string) => {
          const source = sourceById.get(sourceId)
          if (!source) return marker
          return numberedCitation(numberFor(sourceId)!, source)
        })
      })
      .join('')

  const section = findSourcesSection(report)
  if (!section) {
    // No Sources heading of its own. The numbered citations still resolve as
    // links, but without a list the reader has no way to see what [7] is
    // short of hovering every one — observed on a real report that ran to 23
    // references with no legend. Append the list the numbers refer to.
    const body = renderBody(report)
    const list = ordered.map((source, index) => `${index + 1}. ${markdownCitation(source)}`)
    return list.length > 0 ? `${body}\n\n## Sources\n\n${list.join('\n')}\n` : body
  }

  // Rendered before the list is built, so the list reflects the order the prose
  // actually introduced each source.
  const head = renderBody(report.slice(0, section.start))
  const tail = renderBody(report.slice(section.end))
  const list = ordered
    .map((source, index) => `${index + 1}. ${markdownCitation(source)}`)
    .join('\n')
  return `${head}\n\n${list || '_No verified sources were cited._'}\n${tail}`
}

/**
 * Headings whose whole purpose is to describe what the evidence does NOT
 * establish. Requiring a citation for "no source reported service-contract
 * terms for this dealer" is a category error — the statement is true
 * *because* nothing was retrieved, so there is nothing to cite. Flagging them
 * put every honest limits section into the issue list, which is one of the
 * reasons well-sourced runs kept landing `partial`.
 */
const UNCITABLE_SECTION_HEADING =
  /^\s{0,3}#{1,6}\s*(?:\d+[.)]?\s*)*(?:limits?\b|limitations?\b|open questions?\b|caveats?\b|what (?:we )?(?:could not|couldn.t)\b)/i

/**
 * The blocks that sit under an uncitable heading, keyed by their exact text so
 * any validator can skip them without re-deriving section boundaries.
 *
 * Returned as a set of blocks rather than a stripped copy of the report on
 * purpose: `validateNumericClaims` must keep running its *safety* check
 * (a cited figure absent from the cited passage is fabrication, wherever it
 * appears) while skipping only its coverage complaint about uncited figures.
 * Step titles routinely carry years — "…funding allocations for 2024-2026" —
 * and a limits section built from them would otherwise report a numeric claim
 * for every one.
 */
function uncitableBlocks(report: string): Set<string> {
  const blocks = new Set<string>()
  let section: string[] = []
  let exempt = false
  const flush = (): void => {
    if (exempt) {
      for (const block of section.join('\n').split(/\n\s*\n/)) {
        const trimmed = block.trim()
        if (trimmed) blocks.add(trimmed)
      }
    }
    section = []
  }
  for (const line of report.split('\n')) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      flush()
      exempt = UNCITABLE_SECTION_HEADING.test(line)
      continue
    }
    section.push(line)
  }
  flush()
  return blocks
}

function validateCitationCoverage(
  report: string,
  collector: IssueCollector,
  exempt: Set<string>
): void {
  const withoutCode = report.replace(/```[\s\S]*?```/g, '')
  for (const block of withoutCode.split(/\n\s*\n/)) {
    if (exempt.has(block.trim())) continue
    const prose = block
      .split('\n')
      .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line) && !/^\s*[-*_]{3,}\s*$/.test(line))
      .join(' ')
      .trim()
    if (!prose || /\[\[S\d+(?::P\d+)?\]\]/.test(prose)) continue
    const words = prose
      .replace(/<[^>]+>/g, ' ')
      .replace(/[^\p{L}\p{N}'’-]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (words.length < 5) continue
    // Coverage, not safety: an uncited prose block is incomplete, not false.
    collector.coverage.push(
      `Material report text has no evidence citation: ${truncateIssue(prose)}`
    )
  }
}

function validateSourceQualityCoverage(
  report: string,
  sourceById: Map<string, CriticalThinkingSource>,
  collector: IssueCollector
): void {
  for (const block of report.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/)) {
    const prose = block
      .split('\n')
      .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
      .join(' ')
      .replace(/\[\[S\d+(?::P\d+)?\]\]/g, ' ')
      .trim()
    if (wordCount(prose) < 8) continue
    const sourceIds = [
      ...new Set([...block.matchAll(/\[\[(S\d+)(?::P\d+)?\]\]/g)].map((match) => match[1]))
    ]
    if (sourceIds.length === 0) continue
    const citedSources = sourceIds.flatMap((id) => {
      const source = sourceById.get(id)
      return source ? [source] : []
    })
    if (
      citedSources.length > 0 &&
      citedSources.every((source) => isWeakCriticalThinkingSource(source.url, source.title))
    ) {
      collector.coverage.push(
        `Material claim relies only on general-reference or commercial evidence: ${truncateIssue(prose)}`
      )
    }
  }
}

function wordCount(value: string): number {
  return value
    .replace(/[^\p{L}\p{N}'’-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function renderChartCitation(
  block: string,
  sourceById: Map<string, CriticalThinkingSource>,
  numberFor: (sourceId: string) => number | null
): string {
  const match = /^```chart\s*([\s\S]*?)```$/.exec(block)
  if (!match) return block
  try {
    const chart = JSON.parse(match[1]) as { source?: unknown }
    if (typeof chart.source !== 'string') return block
    const sourceId = /\[\[(S\d+)(?::P\d+)?\]\]/.exec(chart.source)?.[1]
    const source = sourceId ? sourceById.get(sourceId) : undefined
    if (!source) return block
    // A chart's source is a standalone caption, not something a reader has to
    // step over mid-sentence, so it keeps the full title — but it still claims
    // a number, so the same source reads as the same reference everywhere.
    numberFor(sourceId!)
    chart.source = markdownCitation(source)
    return `\`\`\`chart\n${JSON.stringify(chart)}\n\`\`\``
  } catch {
    return block
  }
}

/** A citation a reader can step over: the reference number, linking to the source. */
function numberedCitation(index: number, source: CriticalThinkingSource): string {
  const url = source.url.replace(/\\/g, '%5C').replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `[${index}](${url})`
}

function markdownCitation(source: CriticalThinkingSource): string {
  const title =
    source.title
      .replace(/\p{Cc}/gu, ' ')
      .replace(/[\\[\]<>*_`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || source.id
  const url = source.url.replace(/\\/g, '%5C').replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `[${title}](${url})`
}

function trustedVerifiedSources(sources: CriticalThinkingSource[]): CriticalThinkingSource[] {
  return sources.flatMap((source) => {
    if (!source.verified || source.url.length > 4_096) return []
    try {
      const url = new URL(source.url)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        return []
      }
      return [{ ...source, url: url.toString() }]
    } catch {
      return []
    }
  })
}

function truncateIssue(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 119)}…` : normalized
}

/**
 * Fold a quotation that was written across lines back onto one, dropping the
 * `>` each continuation line carries in a markdown block quote. Without this,
 * allowing quotes to span lines would turn every genuine block quote into a
 * fabrication report: the marker survives normalization and no fetched passage
 * has ever contained a stray `>` mid-sentence.
 */
function stripBlockQuoteMarkers(value: string): string {
  return value.replace(/\n\s*>?\s*/g, ' ')
}

export function normalizeQuote(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Assign IDs once per URL so repeated focused fetches cannot reuse P1/P2. */
function fetchedPassagesByUrl(artifacts: ToolArtifact[]): Map<string, EvidencePassage[]> {
  const fetched = new Map<string, EvidencePassage[]>()
  const seenByUrl = new Map<string, Set<string>>()
  for (const artifact of artifacts) {
    if (artifact.kind !== 'web-fetch') continue
    const key = canonicalResearchUrl(artifact.finalUrl)
    const passages = fetched.get(key) ?? []
    const seen = seenByUrl.get(key) ?? new Set<string>()
    for (const passage of artifact.passages) {
      const identity = normalizeQuote(passage.text)
      if (seen.has(identity)) continue
      seen.add(identity)
      passages.push({ ...passage, id: `P${passages.length + 1}` })
    }
    fetched.set(key, passages)
    seenByUrl.set(key, seen)
  }
  return fetched
}

function validateCharts(
  report: string,
  passagesByUrl: Map<string, EvidencePassage[]>,
  sourceById: Map<string, CriticalThinkingSource>,
  collector: IssueCollector
): void {
  for (const match of report.matchAll(/```chart\s*([\s\S]*?)```/g)) {
    try {
      const chart = parseChartForValidation(JSON.parse(match[1]))
      if (!chart) {
        // A chart presented as evidence-backed but malformed is a safety
        // concern — it would render a claim the schema can't vouch for.
        collector.safety.push('A chart block does not match the supported chart schema.')
        continue
      }
      const evidenceText = passagesForCitations(chart.source, passagesByUrl, sourceById).join(' ')
      // A chart cites one passage for a whole series, so its values routinely
      // sit a passage or two away from the marker. Same distinction the
      // quotation and numeric checks make: on the cited page under a different
      // marker is a citation pointing slightly off, not an invented figure.
      const wholeSourceText = passagesForCitations(
        chart.source,
        passagesByUrl,
        sourceById,
        true
      ).join(' ')
      for (const value of chart.datasets.flatMap((dataset) => dataset.values)) {
        if (chartValueAppears(evidenceText, value, chart.unit)) continue
        const label = `${value}${chart.unit ? ` ${chart.unit}` : ''}`
        if (chartValueAppears(wholeSourceText, value, chart.unit)) {
          collector.coverage.push(
            `Chart value ${label} is on the cited page but under a different passage marker.`
          )
          continue
        }
        collector.safety.push(
          `Chart value ${label} is not present with the same unit in its cited evidence passage.`
        )
      }
    } catch {
      collector.safety.push('A chart block is not valid JSON.')
    }
  }
}

function parseChartForValidation(value: unknown): {
  datasets: Array<{ values: number[] }>
  source: string
  unit?: string
} | null {
  if (!isRecord(value)) return null
  const type = value.type
  if (type !== 'bar' && type !== 'line' && type !== 'pie') return null
  if (!boundedText(value.title, 120)) return null
  if (typeof value.source !== 'string' || !/^\[\[S\d+(?::P\d+)?\]\]$/.test(value.source)) {
    return null
  }
  if (!Array.isArray(value.labels) || value.labels.length < 2) return null
  if (value.labels.length > (type === 'pie' ? 8 : 12)) return null
  if (value.labels.some((label) => !boundedText(label, 60))) return null
  if (
    !Array.isArray(value.datasets) ||
    value.datasets.length < 1 ||
    value.datasets.length > 4 ||
    (type === 'pie' && value.datasets.length !== 1)
  ) {
    return null
  }
  const datasets: Array<{ values: number[] }> = []
  for (const dataset of value.datasets) {
    if (!isRecord(dataset) || !boundedText(dataset.label, 60) || !Array.isArray(dataset.values)) {
      return null
    }
    if (dataset.values.length !== value.labels.length) return null
    if (
      dataset.values.some(
        (point) => typeof point !== 'number' || !Number.isFinite(point) || Math.abs(point) > 1e15
      )
    ) {
      return null
    }
    datasets.push({ values: dataset.values as number[] })
  }
  if (type === 'pie') {
    const values = datasets[0].values
    if (values.some((point) => point < 0) || values.every((point) => point === 0)) return null
  }
  const unit = value.unit === undefined ? undefined : boundedText(value.unit, 20)
  if (value.unit !== undefined && !unit) return null
  if (value.note !== undefined && !boundedText(value.note, 300)) return null
  return { datasets, source: value.source, ...(unit ? { unit } : {}) }
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= maxLength ? text : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether a figure is distinctive enough that its presence in the evidence
 * means something.
 *
 * A unit, a decimal point, or three or more digits all make a figure specific
 * enough to verify -- a percentage, a measurement, a year, a count in the
 * thousands. A bare one- or two-digit integer does not: it is a list position
 * or a small tally as often as a claim, and it appears in almost any page.
 */
function isVerifiableFigure(value: string): boolean {
  const raw = value.trim().toLowerCase()
  if (/%$|\bpercent\b|\bpercentage\s+points?$/.test(raw)) return true
  if (raw.includes('.')) return true
  return (raw.match(/\d/g) ?? []).length >= 3
}

function numberAppears(text: string, value: number | string): boolean {
  const expected = normalizeNumber(value)
  const candidates = extractNumbers(text).map(normalizeNumber)
  if (candidates.includes(expected)) return true

  // A claim that carries no unit is satisfied by the same figure carrying one.
  // Ranges are why this matters: "82-93%" is the ordinary way to write a
  // percentage range, and it yields a *bare* first claim ("82") because the
  // sign sits at the end. Evidence reading "82% to 93%" would then fail
  // forever — `number:82` never equals `percent:82` — rejecting a correctly
  // cited report over its punctuation.
  //
  // The asymmetry is deliberate and is the whole safety property: a bare claim
  // may match a united figure, because the number really is in the evidence and
  // the claim merely says less than the source. The reverse must still fail —
  // a claim of "82%" against evidence saying only "82" is the model attaching a
  // unit the source never gave, which is exactly the fabrication this guards.
  if (!expected.startsWith('number:')) return false
  const figure = expected.slice('number:'.length)
  return candidates.some((candidate) => candidate.slice(candidate.indexOf(':') + 1) === figure)
}

function extractNumbers(value: string): string[] {
  const normal =
    value.match(/\b\d+(?:,\d{3})*(?:\.\d+)?(?:%|\s+percentage\s+points?\b|\s+percent\b)?/gi) ?? []
  // HTML table extraction can collapse a cell boundary into text such as
  // "Wasp1.3Most toxic". Decimal values are still exact evidence and must not
  // be rejected merely because the preceding letter removes the word boundary.
  const collapsedDecimals =
    value.match(/(?<=[\p{L})])\d+\.\d+(?:%|\s+percentage\s+points?\b|\s+percent\b)?/giu) ?? []
  return [...new Set([...normal, ...collapsedDecimals])]
}

function normalizeNumber(value: number | string): string {
  const raw = String(value).replace(/,/g, '').trim().toLowerCase()
  const kind = /%$|\spercent$/.test(raw)
    ? 'percent'
    : /\spercentage\s+points?$/.test(raw)
      ? 'percentage-point'
      : 'number'
  const numeric = /^\d+(?:\.\d+)?/.exec(raw)?.[0] ?? raw
  const parsed = Number(numeric)
  return `${kind}:${Number.isFinite(parsed) ? String(parsed) : numeric}`
}

function chartValueAppears(text: string, value: number, unit: string | undefined): boolean {
  const normalizedUnit = unit?.trim().toLowerCase()
  if (!normalizedUnit) return numberAppears(text, value)
  if (normalizedUnit === '%' || normalizedUnit === 'percent' || normalizedUnit === 'percentage') {
    return numberAppears(text, `${value}%`)
  }
  if (
    normalizedUnit === 'percentage point' ||
    normalizedUnit === 'percentage points' ||
    normalizedUnit === 'pp'
  ) {
    return numberAppears(text, `${value} percentage points`)
  }
  return numberAppears(text, value) && evidenceContainsUnit(text, normalizedUnit)
}

function evidenceContainsUnit(text: string, unit: string): boolean {
  const normalizedText = normalizeQuote(text)
  const canonical = canonicalUnit(unit)
  const aliases = UNIT_ALIASES[canonical]
  if (!aliases) return normalizedText.includes(normalizeQuote(unit))
  return aliases.some((alias) => alias.test(normalizedText))
}

function canonicalUnit(unit: string): string {
  const normalized = unit.normalize('NFKC').trim().toLowerCase().replace(/\.$/, '')
  for (const [canonical, aliases] of Object.entries(UNIT_INPUT_ALIASES)) {
    if (aliases.includes(normalized)) return canonical
  }
  return normalized
}

const UNIT_INPUT_ALIASES: Record<string, string[]> = {
  microgram: ['μg', 'µg', 'ug', 'mcg', 'microgram', 'micrograms'],
  milligram: ['mg', 'milligram', 'milligrams'],
  gram: ['g', 'gram', 'grams'],
  kilogram: ['kg', 'kilogram', 'kilograms']
}

const UNIT_ALIASES: Record<string, RegExp[]> = {
  microgram: [/\b(?:ug|mcg|micrograms?)\b/u, /(?:μg|µg)/u],
  milligram: [/\b(?:mg|milligrams?)\b/u],
  gram: [/\b(?:g|grams?)\b/u],
  kilogram: [/\b(?:kg|kilograms?)\b/u]
}
