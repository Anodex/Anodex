import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact, WebFetchArtifact } from '@shared/toolArtifacts.types'

export interface ReportValidationResult {
  valid: boolean
  issues: string[]
}

/** Build a bounded, exact evidence packet; only fetched pages can support citations. */
export function buildEvidencePacket(
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[],
  maxChars = 36_000
): string {
  const sourceByUrl = new Map(sources.map((source) => [canonicalUrl(source.url), source]))
  const sections: string[] = []
  let used = 0
  for (const artifact of artifacts) {
    if (artifact.kind !== 'web-fetch') continue
    const source = sourceByUrl.get(canonicalUrl(artifact.finalUrl))
    if (!source?.verified) continue
    const header = `[${source.id}] ${source.title}\nURL: ${source.url}`
    const passages = artifact.passages.map(
      (passage) => `[${source.id}:${passage.id}] ${passage.text}`
    )
    const section = [header, ...passages].join('\n')
    if (used + section.length > maxChars) {
      const remaining = maxChars - used
      if (remaining > header.length + 120) sections.push(section.slice(0, remaining))
      break
    }
    sections.push(section)
    used += section.length + 2
  }
  return sections.join('\n\n')
}

export function validateResearchReport(
  report: string,
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[]
): ReportValidationResult {
  const issues: string[] = []
  const sourceById = new Map(
    sources.filter((source) => source.verified).map((source) => [source.id, source])
  )
  const fetchedByUrl = fetchedArtifactsByUrl(artifacts)
  const citations = [...report.matchAll(/\[\[(S\d+)(?::(P\d+))?\]\]/g)]
  const citationIds = citations.map((match) => match[1])
  for (const id of new Set(citationIds)) {
    if (!sourceById.has(id)) issues.push(`Unknown or unfetched citation ${id}.`)
  }
  for (const citation of citations) {
    const source = sourceById.get(citation[1])
    const artifact = source ? fetchedByUrl.get(canonicalUrl(source.url)) : undefined
    if (citation[2] && !artifact?.passages.some((passage) => passage.id === citation[2])) {
      issues.push(`Unknown evidence passage ${citation[1]}:${citation[2]}.`)
    }
  }

  for (const match of report.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    const rawUrl = match[0].replace(/[.,;:!?]+$/, '')
    if (![...fetchedByUrl.keys()].includes(canonicalUrl(rawUrl))) {
      issues.push(`Raw URL is not backed by fetched evidence: ${rawUrl}`)
    } else {
      issues.push(`Use an internal citation marker instead of a raw URL: ${rawUrl}`)
    }
  }

  const allPassages = [...fetchedByUrl.values()]
    .flatMap((artifact) => artifact.passages.map((passage) => passage.text))
    .map(normalizeQuote)
  const proseReport = report.replace(/```[\s\S]*?```/g, '')
  for (const match of proseReport.matchAll(/[“"]([^”"\n]{20,})[”"]/g)) {
    const quote = normalizeQuote(match[1])
    if (!allPassages.some((passage) => passage.includes(quote))) {
      issues.push(`Quoted text is not present in fetched passages: “${match[1].slice(0, 80)}”`)
    }
  }

  validateCharts(report, fetchedByUrl, sourceById, issues)
  validateNumericClaims(proseReport, fetchedByUrl, sourceById, issues)
  if (citationIds.length === 0) issues.push('The report contains no evidence citation markers.')
  return { valid: issues.length === 0, issues: [...new Set(issues)] }
}

function validateNumericClaims(
  report: string,
  fetchedByUrl: Map<string, WebFetchArtifact>,
  sourceById: Map<string, CriticalThinkingSource>,
  issues: string[]
): void {
  for (const paragraph of report.split(/\n{2,}/)) {
    const citations = [...paragraph.matchAll(/\[\[(S\d+)(?::(P\d+))?\]\]/g)]
    if (citations.length === 0) continue
    const claimText = paragraph.replace(/\[\[S\d+(?::P\d+)?\]\]/g, '')
    const numbers = claimText.match(/\b\d[\d,.]*%?/g) ?? []
    for (const number of numbers) {
      if (number.length === 1 && !number.endsWith('%')) continue
      const evidenceText = citations
        .flatMap((citation) => {
          const source = sourceById.get(citation[1])
          const artifact = source ? fetchedByUrl.get(canonicalUrl(source.url)) : undefined
          return (
            artifact?.passages
              .filter((passage) => !citation[2] || passage.id === citation[2])
              .map((passage) => passage.text) ?? []
          )
        })
        .join(' ')
      if (!evidenceText.includes(number.replace(/%$/, ''))) {
        issues.push(`Numeric claim ${number} is not present in its cited evidence.`)
      }
    }
  }
}

/** Convert validated internal IDs into deterministic clickable Markdown links. */
export function renderResearchCitations(report: string, sources: CriticalThinkingSource[]): string {
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  return report.replace(/\[\[(S\d+)(?::(P\d+))?\]\]/g, (marker, sourceId: string) => {
    const source = sourceById.get(sourceId)
    return source ? `[${source.title}](${source.url})` : marker
  })
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

function fetchedArtifactsByUrl(artifacts: ToolArtifact[]): Map<string, WebFetchArtifact> {
  const fetched = new Map<string, WebFetchArtifact>()
  for (const artifact of artifacts) {
    if (artifact.kind === 'web-fetch') fetched.set(canonicalUrl(artifact.finalUrl), artifact)
  }
  return fetched
}

function validateCharts(
  report: string,
  fetchedByUrl: Map<string, WebFetchArtifact>,
  sourceById: Map<string, CriticalThinkingSource>,
  issues: string[]
): void {
  for (const match of report.matchAll(/```chart\s*([\s\S]*?)```/g)) {
    try {
      const chart = JSON.parse(match[1]) as {
        datasets?: Array<{ values?: number[] }>
        source?: string
      }
      const sourceId = /\[\[(S\d+)(?::P\d+)?\]\]/.exec(chart.source ?? '')?.[1]
      const source = sourceId ? sourceById.get(sourceId) : undefined
      const artifact = source ? fetchedByUrl.get(canonicalUrl(source.url)) : undefined
      const evidenceText = artifact?.passages.map((passage) => passage.text).join(' ') ?? ''
      for (const value of chart.datasets?.flatMap((dataset) => dataset.values ?? []) ?? []) {
        if (!numberAppears(evidenceText, value)) {
          issues.push(`Chart value ${value} is not present in its cited evidence passage.`)
        }
      }
    } catch {
      issues.push('A chart block is not valid JSON.')
    }
  }
}

function numberAppears(text: string, value: number): boolean {
  const plain = String(value)
  return text.includes(plain) || text.includes(value.toLocaleString('en-US'))
}

function canonicalUrl(value: string): string {
  return value.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase()
}
