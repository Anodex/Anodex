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
  const citedBlocks = sectionEntries
    .flatMap(substantiveBlocks)
    .filter((block) => CITATION_PATTERN.test(block))
  const executiveSummary =
    input.overview?.executiveSummary.trim() || citedBlocks[0] || 'Evidence summary unavailable.'
  const conclusion =
    input.overview?.conclusion.trim() || citedBlocks.at(-1) || 'No safe synthesis available.'
  const limits = buildLimitsBlock(input.steps)
  const sourceMarkers = input.sources
    .filter((source) => source.verified)
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
