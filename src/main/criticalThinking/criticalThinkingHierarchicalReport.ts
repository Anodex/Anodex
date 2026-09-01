import type {
  CriticalThinkingSource,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { normalizeCitationMarkers, validateResearchReport } from './criticalThinkingEvidence'

const CITATION_PATTERN = /\[\[S\d+(?::P\d+)?\]\]/

export interface HierarchicalSectionCandidate {
  content: string
  safe: boolean
  valid: boolean
  usable: boolean
  issues: string[]
  citedBlockCount: number
}

export interface HierarchicalOverview {
  executiveSummary: string
  conclusion: string
}

export function evaluateHierarchicalSection(
  content: string,
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[],
  /** The run's question, so a figure it states is not read as fabrication. */
  question?: string
): HierarchicalSectionCandidate {
  const trimmed = normalizeCitationMarkers(content.trim())
  const validation = validateResearchReport(trimmed, artifacts, sources, question)
  const citedBlockCount = substantiveBlocks(trimmed).filter((block) =>
    CITATION_PATTERN.test(block)
  ).length
  const safe = validation.safetyIssues.length === 0
  return {
    content: trimmed,
    safe,
    valid: validation.valid,
    usable: safe && citedBlockCount > 0 && trimmed.length >= 80,
    issues: validation.issues,
    citedBlockCount
  }
}

export function chooseBetterHierarchicalSection(
  original: HierarchicalSectionCandidate,
  repaired: HierarchicalSectionCandidate
): HierarchicalSectionCandidate {
  if (original.usable !== repaired.usable) return original.usable ? original : repaired
  if (original.safe !== repaired.safe) return original.safe ? original : repaired
  if (original.valid !== repaired.valid) return original.valid ? original : repaired
  if (original.citedBlockCount !== repaired.citedBlockCount) {
    return original.citedBlockCount > repaired.citedBlockCount ? original : repaired
  }
  if (original.issues.length !== repaired.issues.length) {
    return original.issues.length < repaired.issues.length ? original : repaired
  }
  return repaired.content.length > original.content.length ? repaired : original
}

export function parseHierarchicalOverview(content: string): HierarchicalOverview | null {
  const trimmed = content.trim()
  const candidates = [trimmed]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim()
  if (fenced) candidates.push(fenced)
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (!isRecord(parsed)) continue
      const executiveSummary = stringValue(parsed.executiveSummary)
      const conclusion = stringValue(parsed.conclusion)
      if (executiveSummary && conclusion) return { executiveSummary, conclusion }
    } catch {
      // Try the next bounded representation.
    }
  }
  return null
}

export function assembleHierarchicalReport(input: {
  title: string
  steps: CriticalThinkingStepState[]
  sections: Map<string, string>
  overview: HierarchicalOverview | null
  sources: CriticalThinkingSource[]
}): string {
  const sectionEntries = input.steps.flatMap((step, index) => {
    const content = input.sections.get(step.id)?.trim()
    return content ? [`### ${index + 1}. ${step.title}\n\n${content}`] : []
  })
  const deterministicOverview = buildDeterministicOverview(input.steps, input.sections)
  const executiveSummary =
    input.overview?.executiveSummary.trim() ||
    deterministicOverview.executiveSummary ||
    'Evidence summary unavailable.'
  const conclusion =
    input.overview?.conclusion.trim() ||
    deterministicOverview.conclusion ||
    'No safe synthesis available.'
  const limits = buildLimitsBlock(input.steps)
  const citedSourceIds = new Set(
    [executiveSummary, ...sectionEntries, conclusion]
      .join('\n')
      .match(/\[\[(S\d+)(?::P\d+)?\]\]/g)
      ?.map((marker) => marker.slice(2).split(':')[0].replace(']]', '')) ?? []
  )
  const sourceMarkers = input.sources
    .filter((source) => source.verified && citedSourceIds.has(source.id))
    .map((source) => `[[${source.id}]]`)
    .join(' ')

  return [
    `# ${input.title}`,
    '',
    '## Executive Summary',
    '',
    executiveSummary,
    '',
    '## Detailed Findings',
    '',
    sectionEntries.join('\n\n'),
    '',
    '## Limits and Open Questions',
    '',
    limits,
    '',
    '## Sources',
    '',
    sourceMarkers || 'None verified.',
    '',
    '## Conclusion',
    '',
    conclusion
  ].join('\n')
}

/**
 * How many citation markers the deterministic conclusion carries. It exists to
 * satisfy citation coverage for its own sentence, not to re-list the
 * bibliography: the previous version appended every marker in the report,
 * which on a real run meant a closing "paragraph" of 21 stacked links under a
 * sentence that said nothing.
 */
const MAX_CONCLUSION_MARKERS = 3

function buildDeterministicConclusion(
  steps: CriticalThinkingStepState[],
  sections: Map<string, string>,
  markers: string[]
): string {
  const complete = steps.every((step) => sections.has(step.id) && step.status === 'completed')
  // Deliberately free of numerals and of step titles (which carry years and
  // figures of their own). A digit anywhere in the report body makes
  // `reportHasQuantitativeProse` true, which spends an extra model call
  // hunting for a chart to draw, and an uncited digit is separately reported
  // as a numeric claim with no evidence. The limits section directly above
  // already names what went unresolved, so repeating it here buys nothing.
  const scope = complete
    ? 'Every planned line of inquiry returned citable evidence, and each section above states its conclusion against the passages it cites.'
    : 'Some planned lines of inquiry returned no citable evidence — the limits section above names them. Each section states its conclusion only against the passages it cites.'
  const cited = markers.slice(0, MAX_CONCLUSION_MARKERS).join(' ')
  return `${scope} ${cited}`.trim()
}

function buildDeterministicOverview(
  steps: CriticalThinkingStepState[],
  sections: Map<string, string>
): HierarchicalOverview {
  const summaries = steps.flatMap((step) => {
    const section = sections.get(step.id)
    if (!section) return []
    const block = substantiveBlocks(section).find((item) => CITATION_PATTERN.test(item))
    if (!block) return []
    const markers = [...block.matchAll(/\[\[S\d+(?::P\d+)?\]\]/g)].map((match) => match[0])
    const prose = block
      .replace(/\[\[S\d+(?::P\d+)?\]\]/g, '')
      .replace(/^\s*[-*]\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    const firstSentence = /^.{1,600}?[.!?](?=\s|$)/.exec(prose)?.[0] ?? firstBoundedLine(prose)
    if (!firstSentence || markers.length === 0) return []
    return [`- ${firstSentence} ${[...new Set(markers)].join(' ')}`]
  })
  if (summaries.length === 0) return { executiveSummary: '', conclusion: '' }
  const markers = [
    ...new Set(summaries.flatMap((summary) => summary.match(/\[\[S\d+(?::P\d+)?\]\]/g) ?? []))
  ]
  return {
    executiveSummary: summaries.join('\n'),
    conclusion: buildDeterministicConclusion(steps, sections, markers)
  }
}

function firstBoundedLine(value: string): string {
  const line = value.split('\n')[0]?.trim() ?? ''
  if (line.length <= 600) return line
  const boundary = line.lastIndexOf(' ', 599)
  return `${line.slice(0, boundary > 80 ? boundary : 599).trimEnd()}…`
}

function buildLimitsBlock(steps: CriticalThinkingStepState[]): string {
  const seen = new Set<string>()
  const lines = steps.flatMap((step) => {
    const title = boundedText(step.title, 100)
    const gaps = step.uncertainties
      .map((gap) => gap.replace(/\s+/g, ' ').trim())
      .slice(0, 2)
      .filter((gap) => {
        const key = gap.toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((gap) => `${title}: ${boundedText(gap, 220)}`)
    if (gaps.length > 0) return gaps
    if (step.status !== 'completed') return [`${title}: research remained ${step.status}.`]
    return []
  })
  // A markdown list, not a fenced block. These are prose limits a reader
  // needs to weigh, and a code fence rendered them as grey monospace — the
  // least readable presentation available for the one section that qualifies
  // everything above it. Citation coverage exempts this section by heading
  // (see `validateCitationCoverage`), so leaving the fence off no longer
  // costs the report a wall of "material text has no citation" issues.
  return lines.length > 0
    ? lines
        .slice(0, 12)
        .map((line) => `- ${line}`)
        .join('\n')
    : 'No material gaps recorded.'
}

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const boundary = value.lastIndexOf(' ', maxChars - 1)
  return `${value.slice(0, boundary >= 40 ? boundary : maxChars - 1).trimEnd()}…`
}

function substantiveBlocks(content: string): string[] {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length >= 40 && !/^#{1,6}\s/.test(block))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
