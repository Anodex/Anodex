import type {
  CriticalThinkingSource,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
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

  const sourcesLine =
    verifiedSources.length > 0
      ? verifiedSources.map((source) => `[[${source.id}]]`).join(' ')
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
  const bullets = excerpts
    .slice(0, MAX_EXCERPTS_PER_STEP)
    .map(
      (excerpt) =>
        `- ${truncateExcerpt(excerpt.text, MAX_EXCERPT_CHARS)} [[${excerpt.sourceId}:${excerpt.passageId}]]`
    )
  return `${heading}\n\n${bullets.join('\n')}`
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
  const candidatesByStep = new Map<string, Map<string, StepExcerpt[]>>()
  for (const artifact of artifacts) {
    if (artifact.kind !== 'web-fetch' || artifact.passages.length === 0) continue
    const stepId = artifact.research?.stepId
    if (!stepId || !stepById.has(stepId)) continue
    const source = sourceByUrl.get(canonicalResearchUrl(artifact.finalUrl))
    if (!source) continue
    const bySource = candidatesByStep.get(stepId) ?? new Map<string, StepExcerpt[]>()
    const sourceExcerpts = bySource.get(source.id) ?? []
    for (const passage of artifact.passages) {
      const text = passage.text.trim()
      if (!text) continue
      sourceExcerpts.push({ sourceId: source.id, passageId: passage.id, text })
    }
    bySource.set(source.id, sourceExcerpts)
    candidatesByStep.set(stepId, bySource)
  }

  const byStep = new Map<string, StepExcerpt[]>()
  for (const [stepId, bySource] of candidatesByStep) {
    const selected: StepExcerpt[] = []
    const groups = [...bySource.values()]
    for (let passageIndex = 0; selected.length < MAX_EXCERPTS_PER_STEP; passageIndex += 1) {
      let added = false
      for (const excerpts of groups) {
        const excerpt = excerpts[passageIndex]
        if (!excerpt) continue
        selected.push(excerpt)
        added = true
        if (selected.length >= MAX_EXCERPTS_PER_STEP) break
      }
      if (!added) break
    }
    byStep.set(stepId, selected)
  }
  return byStep
}

function truncateExcerpt(value: string, maxChars = 200): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`
}
