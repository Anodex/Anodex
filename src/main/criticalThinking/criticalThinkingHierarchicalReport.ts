import type {
  CriticalThinkingSource,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { validateResearchReport } from './criticalThinkingEvidence'

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
  sources: CriticalThinkingSource[]
): HierarchicalSectionCandidate {
  const trimmed = content.trim()
  const validation = validateResearchReport(trimmed, artifacts, sources)
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
    conclusion: `Taken together, the retained evidence supports the topic-by-topic findings above while the limits section preserves unresolved questions. ${markers.join(' ')}`
  }
}

function firstBoundedLine(value: string): string {
  const line = value.split('\n')[0]?.trim() ?? ''
  if (line.length <= 600) return line
  const boundary = line.lastIndexOf(' ', 599)
  return `${line.slice(0, boundary > 80 ? boundary : 599).trimEnd()}…`
}

function buildLimitsBlock(steps: CriticalThinkingStepState[]): string {
  const lines = steps.flatMap((step) => {
    const gaps = step.uncertainties.map((gap) => `${step.title}: ${gap}`)
    if (gaps.length > 0) return gaps
    if (step.status !== 'completed') return [`${step.title}: research remained ${step.status}.`]
    return []
  })
  return lines.length > 0
    ? ['```text', ...lines.slice(0, 24), '```'].join('\n')
    : 'No material gaps recorded.'
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
