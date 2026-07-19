import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { EvidencePassage, ToolArtifact } from '@shared/toolArtifacts.types'
import { canonicalResearchUrl } from './criticalThinkingUrl'

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
  const sourceByUrl = new Map(sources.map((source) => [canonicalResearchUrl(source.url), source]))
  const passagesByUrl = fetchedPassagesByUrl(artifacts)
  const sections: string[] = []
  let used = 0
  for (const [url, passages] of passagesByUrl) {
    const source = sourceByUrl.get(url)
    if (!source?.verified) continue
    const header = `[${source.id}] ${source.title}\nURL: ${source.url}`
    const passageLines = passages.map((passage) => `[${source.id}:${passage.id}] ${passage.text}`)
    const sectionSeparatorChars = sections.length > 0 ? 2 : 0
    const sectionLimit = maxChars - used - sectionSeparatorChars
    if (sectionLimit <= header.length + 1) continue
    const accepted = [header]
    let sectionLength = header.length
    for (const line of passageLines) {
      const remaining = sectionLimit - sectionLength - 1
      if (remaining <= 0) break
      if (line.length <= remaining) {
        accepted.push(line)
        sectionLength += line.length + 1
        continue
      }
      const markerEnd = line.indexOf('] ') + 2
      if (markerEnd > 1 && remaining >= markerEnd + 32) {
        accepted.push(line.slice(0, remaining))
        sectionLength += remaining + 1
      }
      break
    }
    if (accepted.length > 1) {
      sections.push(accepted.join('\n'))
      used += sectionLength + sectionSeparatorChars
    }
    if (used >= maxChars) break
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
  const passagesByUrl = fetchedPassagesByUrl(artifacts)
  const citations = [...report.matchAll(/\[\[(S\d+)(?::(P\d+))?\]\]/g)]
  const citationIds = citations.map((match) => match[1])
  for (const id of new Set(citationIds)) {
    if (!sourceById.has(id)) issues.push(`Unknown or unfetched citation ${id}.`)
  }
  for (const citation of citations) {
    const source = sourceById.get(citation[1])
    const passages = source ? passagesByUrl.get(canonicalResearchUrl(source.url)) : undefined
    if (citation[2] && !passages?.some((passage) => passage.id === citation[2])) {
      issues.push(`Unknown evidence passage ${citation[1]}:${citation[2]}.`)
    }
  }

  for (const match of report.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    const rawUrl = match[0].replace(/[.,;:!?]+$/, '')
    if (!passagesByUrl.has(canonicalResearchUrl(rawUrl))) {
      issues.push(`Raw URL is not backed by fetched evidence: ${rawUrl}`)
    } else {
      issues.push(`Use an internal citation marker instead of a raw URL: ${rawUrl}`)
    }
  }

  const allPassages = [...passagesByUrl.values()]
    .flatMap((passages) => passages.map((passage) => passage.text))
    .map(normalizeQuote)
  const proseReport = report.replace(/```[\s\S]*?```/g, '')
  for (const match of proseReport.matchAll(/[“"]([^”"\n]{20,})[”"]/g)) {
    const quote = normalizeQuote(match[1])
    if (!allPassages.some((passage) => passage.includes(quote))) {
      issues.push(`Quoted text is not present in fetched passages: “${match[1].slice(0, 80)}”`)
    }
  }

  validateCharts(report, passagesByUrl, sourceById, issues)
  validateNumericClaims(proseReport, passagesByUrl, sourceById, issues)
  if (citationIds.length === 0) issues.push('The report contains no evidence citation markers.')
  return { valid: issues.length === 0, issues: [...new Set(issues)] }
}

function validateNumericClaims(
  report: string,
  passagesByUrl: Map<string, EvidencePassage[]>,
  sourceById: Map<string, CriticalThinkingSource>,
  issues: string[]
): void {
  for (const paragraph of report.split(/\n{2,}/)) {
    const citations = [...paragraph.matchAll(/\[\[(S\d+)(?::(P\d+))?\]\]/g)]
    if (citations.length === 0) continue
    const claimText = paragraph.replace(/\[\[S\d+(?::P\d+)?\]\]/g, '')
    const numbers = extractNumbers(claimText)
    for (const number of numbers) {
      if (number.length === 1 && !number.endsWith('%')) continue
      const evidenceText = citations
        .flatMap((citation) => {
          const source = sourceById.get(citation[1])
          const passages = source ? passagesByUrl.get(canonicalResearchUrl(source.url)) : undefined
          return (passages ?? [])
            .filter((passage) => !citation[2] || passage.id === citation[2])
            .map((passage) => passage.text)
        })
        .join(' ')
      if (!numberAppears(evidenceText, number)) {
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
      const passages = source ? passagesByUrl.get(canonicalResearchUrl(source.url)) : undefined
      const evidenceText = (passages ?? []).map((passage) => passage.text).join(' ')
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

function numberAppears(text: string, value: number | string): boolean {
  const expected = normalizeNumber(value)
  return extractNumbers(text).some((candidate) => normalizeNumber(candidate) === expected)
}

function extractNumbers(value: string): string[] {
  return value.match(/\b\d+(?:,\d{3})*(?:\.\d+)?%?/g) ?? []
}

function normalizeNumber(value: number | string): string {
  const raw = String(value).replace(/,/g, '').replace(/%$/, '')
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? String(parsed) : raw
}
