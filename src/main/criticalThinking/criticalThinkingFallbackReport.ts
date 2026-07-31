import type {
  CriticalThinkingSource,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { normalizeQuote } from './criticalThinkingEvidence'
import { criticalThinkingSourceAuthorityScore } from './criticalThinkingSourceAuthority'
import { canonicalResearchUrl } from './criticalThinkingUrl'

const MAX_EXCERPTS_PER_STEP = 4
const MAX_EXCERPT_CHARS = 480
const MAX_UNCERTAINTY_ITEMS = 12

/**
 * Deterministic, code-built report used only when model synthesis and its
 * one repair attempt both fail report validation (P0-H) — the exact live
 * failure produced 14 verified sources but a 175-character uncited fragment,
 * exposing that as the "report" with nothing built from the durable research
 * artifacts actually gathered. This is the user-value floor, not a
 * replacement for good synthesis: every finding is a direct, cited excerpt
 * from a verified fetched passage — never the model's own free-text
 * `step.finding`, which may not be grounded in anything specific enough to
 * cite safely. It must itself pass both `validateResearchReport` (citation
 * safety) and `validateReportContract` (structural completeness).
 */
export function buildDeterministicFallbackReport(
  planTitle: string,
  steps: CriticalThinkingStepState[],
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[]
): string {
  const verifiedSources = sources.filter((source) => source.verified)
  const passagesByStep = groupVerifiedExcerptsByStep(artifacts, sources, steps)
  const untouchedSteps = steps.filter(
    (step) => step.status === 'pending' && step.rounds.length === 0 && step.evidenceIds.length === 0
  )
  const limitedSteps = steps.filter((step) => step.status === 'limited')

  const findingsSections = steps.map((step, index) =>
    buildStepSection(step, index, passagesByStep.get(step.id) ?? [])
  )

  // Kept deliberately terse and as separate blank-line-separated blocks
  // (each strictly under the citation validator's material-claim word
  // threshold, counting the list-marker itself as a token) — full step
  // titles are already visible as headings in the Findings section, which
  // are exempt from that check, so there is no need to repeat them here
  // uncited. Plain sentences, not a markdown list: a lone "-" bullet marker
  // still counts as a word toward that threshold.
  const limitsLines: string[] = []
  if (untouchedSteps.length > 0) limitsLines.push(`${untouchedSteps.length} steps not reached.`)
  if (limitedSteps.length > 0) limitsLines.push(`${limitedSteps.length} steps limited.`)
  if (limitsLines.length === 0) limitsLines.push('None incomplete.')

  const uncertainties = steps
    .flatMap((step) => step.uncertainties)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_UNCERTAINTY_ITEMS)
  // A fenced block, not prose: these are the model's own free-text research
  // gaps, not evidence-backed claims, so they cannot honestly carry a
  // citation — presenting them as a clearly-labeled verbatim note (and
  // outside the citation validator's prose scan, which skips code fences)
  // is safer than either inventing a citation or omitting them.
  const uncertaintyBlock =
    uncertainties.length > 0 ? ['Open questions:', '```', ...uncertainties, '```'].join('\n') : ''

  const citedSourceIds = new Set(
    [...passagesByStep.values()].flatMap((excerpts) =>
      excerpts.slice(0, MAX_EXCERPTS_PER_STEP).map((excerpt) => excerpt.sourceId)
    )
  )
  const sourcesLine =
    citedSourceIds.size > 0
      ? verifiedSources
          .filter((source) => citedSourceIds.has(source.id))
          .map((source) => `[[${source.id}]]`)
          .join(' ')
      : 'None verified.'

  return [
    `# Research result: ${planTitle}`,
    '',
    '## Status',
    '',
    'Investigation is Partial.',
    '',
    '## Findings by Research Step',
    '',
    findingsSections.join('\n\n'),
    '',
    '## Limits and Open Questions',
    '',
    [limitsLines.join('\n\n'), uncertaintyBlock].filter(Boolean).join('\n\n'),
    '',
    '## Sources',
    '',
    sourcesLine,
    '',
    '## Conclusion',
    '',
    'Cited evidence remains above.'
  ].join('\n')
}

interface StepExcerpt {
  sourceId: string
  passageId: string
  text: string
  score: number
}

/** Safe per-step recovery when both model section attempts contain unsupported claims. */
export function buildDeterministicStepSection(
  step: CriticalThinkingStepState,
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[]
): string {
  const excerpts = groupVerifiedExcerptsByStep(artifacts, sources, [step]).get(step.id) ?? []
  return buildStepBody(excerpts)
}

function buildStepSection(
  step: CriticalThinkingStepState,
  index: number,
  excerpts: StepExcerpt[]
): string {
  const heading = `### Step ${index + 1}: ${step.title}`
  if (excerpts.length === 0) {
    const label =
      step.status === 'completed' ? 'No citable evidence retained.' : 'Not investigated.'
    return `${heading}\n\n${label}`
  }
  return `${heading}\n\n${buildStepBody(excerpts)}`
}

/**
 * Excerpt bullets, introduced as what they are. Without the lead-in these
 * sections read as if the report simply trailed off into disconnected
 * sentences — on a real run four of six sections were bare bullet lists, and
 * nothing told the reader they were looking at verbatim source text rather
 * than written analysis.
 *
 * The label shares a block with the first bullet (no blank line between), so
 * the block it belongs to carries that bullet's citation and citation
 * coverage stays satisfied. A blank line here would make it an uncited prose
 * block and cost the report an issue for the privilege of being readable.
 */
function buildStepBody(excerpts: StepExcerpt[]): string {
  const bullets = excerpts
    .slice(0, MAX_EXCERPTS_PER_STEP)
    .map(
      (excerpt) =>
        `- ${truncateExcerpt(excerpt.text, MAX_EXCERPT_CHARS)} [[${excerpt.sourceId}:${excerpt.passageId}]]`
    )
    .join('\n')
  if (!bullets) return bullets
  return `Direct excerpts from the verified sources for this step:\n${bullets}`
}

/** Only verified, fetched passages ever back a fallback excerpt — never `step.finding` prose. */
function groupVerifiedExcerptsByStep(
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[],
  steps: CriticalThinkingStepState[]
): Map<string, StepExcerpt[]> {
  const sourceByUrl = new Map(
    sources
      .filter((source) => source.verified)
      .map((source) => [canonicalResearchUrl(source.url), source])
  )
  const stepById = new Map(steps.map((step) => [step.id, step]))
  const sourcePassageIds = new Map<string, Map<string, string>>()
  const candidatesByStep = new Map<string, Map<string, StepExcerpt[]>>()
  for (const artifact of artifacts) {
    if (artifact.kind !== 'web-fetch' || artifact.passages.length === 0) continue
    const stepId = artifact.research?.stepId
    if (!stepId) continue
    const step = stepById.get(stepId)
    if (!step) continue
    const canonicalUrl = canonicalResearchUrl(artifact.finalUrl)
    const source = sourceByUrl.get(canonicalUrl)
    if (!source) continue
    const passageIds = sourcePassageIds.get(canonicalUrl) ?? new Map<string, string>()
    const bySource = candidatesByStep.get(stepId) ?? new Map<string, StepExcerpt[]>()
    const sourceExcerpts = bySource.get(source.id) ?? []
    for (const passage of artifact.passages) {
      const text = passage.text.trim()
      if (!text) continue
      const identity = normalizeQuote(text)
      let passageId = passageIds.get(identity)
      if (!passageId) {
        passageId = `P${passageIds.size + 1}`
        passageIds.set(identity, passageId)
      }
      if (sourceExcerpts.some((excerpt) => excerpt.passageId === passageId)) continue
      const excerpt = bestExcerptWindow(text, step)
      sourceExcerpts.push({
        sourceId: source.id,
        passageId,
        text: excerpt.text,
        score:
          excerpt.score +
          criticalThinkingSourceAuthorityScore(source.url, source.title, source.snippet) +
          Math.min(20, Math.max(0, passage.score ?? 0) / 10)
      })
    }
    sourcePassageIds.set(canonicalUrl, passageIds)
    bySource.set(source.id, sourceExcerpts)
    candidatesByStep.set(stepId, bySource)
  }

  const byStep = new Map<string, StepExcerpt[]>()
  for (const [stepId, bySource] of candidatesByStep) {
    const rankedGroups = [...bySource.values()]
      .map((excerpts) =>
        [...excerpts]
          .filter((excerpt) => excerpt.score > 20)
          .sort((left, right) => right.score - left.score)
      )
      .filter((excerpts) => excerpts.length > 0)
      .sort((left, right) => (right[0]?.score ?? 0) - (left[0]?.score ?? 0))
    // Start with the strongest passage from each source so recovery remains
    // both relevant and source-diverse. Only then use a second passage from
    // the same page.
    const selected = rankedGroups
      .flatMap((group) => (group[0] ? [group[0]] : []))
      .slice(0, MAX_EXCERPTS_PER_STEP)
    if (selected.length < MAX_EXCERPTS_PER_STEP) {
      const remaining = rankedGroups
        .flatMap((group) => group.slice(1))
        .sort((left, right) => right.score - left.score)
      selected.push(...remaining.slice(0, MAX_EXCERPTS_PER_STEP - selected.length))
    }
    byStep.set(stepId, selected)
  }
  return byStep
}

const EXCERPT_STOP_WORDS = new Set([
  'about',
  'across',
  'after',
  'against',
  'among',
  'and',
  'are',
  'compare',
  'comparison',
  'evidence',
  'for',
  'from',
  'into',
  'review',
  'that',
  'the',
  'their',
  'these',
  'this',
  'those',
  'with'
])

const RESULT_LANGUAGE =
  /\b(result|found|showed|demonstrated|associated|increased|decreased|risk|prevalence|incidence|allergen|anaphyl|sensiti[sz]|venom|pain|sting|behavior|response|rate|percent|concentration)\b/i
const LOW_VALUE_LANGUAGE =
  /\b(methods?|objective|questionnaire|supplement(?:ary)?|available online|fig(?:ure)?\.?|table s\d+|copyright|received|accepted|correspondence)\b/i

function bestExcerptWindow(
  passage: string,
  step: CriticalThinkingStepState
): { text: string; score: number } {
  const normalized = sanitizeExcerpt(passage)
  const terms = relevantTerms(`${step.title} ${step.finding} ${step.uncertainties.join(' ')}`)
  const sentences =
    normalized.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)?.map((item) => item.trim()) ?? []
  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreExcerpt(sentence, terms)
    }))
    .filter(({ sentence }) => sentence.length >= 35)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  const best = ranked[0]
  if (!best) return { text: truncateExcerpt(normalized, MAX_EXCERPT_CHARS), score: 0 }

  let selected = best.sentence
  const adjacent = ranked
    .filter(({ index }) => Math.abs(index - best.index) === 1)
    .sort((left, right) => right.score - left.score)[0]
  if (
    adjacent &&
    adjacent.score > 0 &&
    selected.length + adjacent.sentence.length + 1 <= MAX_EXCERPT_CHARS
  ) {
    selected =
      adjacent.index < best.index
        ? `${adjacent.sentence} ${selected}`
        : `${selected} ${adjacent.sentence}`
  }
  return { text: truncateExcerpt(selected, MAX_EXCERPT_CHARS), score: best.score }
}

function scoreExcerpt(value: string, terms: string[]): number {
  const lower = value.toLowerCase()
  const termHits = terms.filter((term) => lower.includes(term)).length
  let score = termHits * 12
  if (RESULT_LANGUAGE.test(value)) score += 24
  if (/\d/.test(value)) score += 5
  // A strong journal host cannot turn a Methods fragment, figure caption, or
  // supplementary-navigation sentence into a useful report finding.
  if (LOW_VALUE_LANGUAGE.test(value)) score -= 160
  if (value.length >= 80 && value.length <= MAX_EXCERPT_CHARS) score += 8
  return score
}

function relevantTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu)
        ?.filter((term) => !EXCERPT_STOP_WORDS.has(term))
        .slice(0, 40) ?? []
    )
  ]
}

function sanitizeExcerpt(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)>\]]+/gi, '[link omitted]')
    .replace(/\[\[S\d+(?::P\d+)?\]\]/g, '[source marker omitted]')
    .replace(/```/g, "'''")
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateExcerpt(value: string, maxChars = 200): string {
  const normalized = sanitizeExcerpt(value)
  if (normalized.length <= maxChars) return normalized
  const candidate = normalized.slice(0, maxChars - 1)
  const boundary = Math.max(candidate.lastIndexOf('. '), candidate.lastIndexOf(' '))
  return `${candidate.slice(0, boundary >= 80 ? boundary + 1 : maxChars - 1).trimEnd()}…`
}
