import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { EvidencePassage, ToolArtifact } from '@shared/toolArtifacts.types'
import { canonicalResearchUrl } from './criticalThinkingUrl'

export interface ReportValidationResult {
  valid: boolean
  issues: string[]
}

const MIN_INITIAL_PASSAGE_TEXT_CHARS = 32
const MAX_EXTRA_PASSAGE_LINE_CHARS = 360

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
  const candidates = balancedFetchedUrls(artifacts, passagesByUrl).flatMap((url) => {
    const source = sourceByUrl.get(url)
    if (!source?.verified) return []
    const passages = passagesByUrl.get(url) ?? []
    return [
      {
        header: `[${source.id}] ${source.title}\nURL: ${source.url}`,
        passageLines: passages.map((passage) => `[${source.id}:${passage.id}] ${passage.text}`)
      }
    ]
  })
  const selected: Array<{
    header: string
    passageLines: string[]
    minimumFirstLine: string
    minimumLength: number
  }> = []
  let minimumUsed = 0
  for (const candidate of candidates) {
    const firstPassage = candidate.passageLines[0]
    const minimumFirstLine = firstPassage ? minimumEvidenceLine(firstPassage) : null
    if (!minimumFirstLine) continue
    const minimumLength = candidate.header.length + minimumFirstLine.length + 1
    const separator = selected.length > 0 ? 2 : 0
    if (minimumUsed + separator + minimumLength > limit) continue
    selected.push({ ...candidate, minimumFirstLine, minimumLength })
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
  passagesByUrl: Map<string, EvidencePassage[]>
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
  const issues: string[] = []
  const sourceById = new Map(trustedVerifiedSources(sources).map((source) => [source.id, source]))
  const passagesByUrl = fetchedPassagesByUrl(artifacts)
  const citations = [...report.matchAll(/\[\[(S\d+)(?::(P\d+))?\]\]/g)]
  const citationIds = citations.map((match) => match[1])
  for (const id of new Set(citationIds)) {
    if (!sourceById.has(id)) issues.push(`Unknown or unfetched citation ${id}.`)
  }
  for (const citation of citations) {
    const source = sourceById.get(citation[1])
    const passages = source ? passagesByUrl.get(canonicalResearchUrl(source.url)) : undefined
    if (source && !passages?.length) {
      issues.push(`Citation ${citation[1]} has no fetched evidence passages.`)
    } else if (citation[2] && !passages?.some((passage) => passage.id === citation[2])) {
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

  const proseReport = report.replace(/```[\s\S]*?```/g, '')
  for (const block of proseReport.split(/\n{2,}/)) {
    const citedPassages = passagesForCitations(block, passagesByUrl, sourceById).map(normalizeQuote)
    for (const match of block.matchAll(/[“"]([^”"\n]{20,})[”"]/g)) {
      const quote = normalizeQuote(match[1])
      if (!citedPassages.some((passage) => passage.includes(quote))) {
        issues.push(
          `Quoted text is not present in its cited fetched passages: “${match[1].slice(0, 80)}”`
        )
      }
    }
  }

  validateCitationCoverage(proseReport, issues)
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
    const claimText = paragraph.replace(/\[\[S\d+(?::P\d+)?\]\]/g, '')
    const numbers = extractNumbers(claimText)
    if (citations.length === 0) {
      for (const number of numbers) {
        if (number.length === 1 && !number.endsWith('%')) continue
        issues.push(`Numeric claim ${number} has no evidence citation.`)
      }
      continue
    }
    for (const number of numbers) {
      if (number.length === 1 && !number.endsWith('%')) continue
      const evidenceText = passagesForCitations(paragraph, passagesByUrl, sourceById).join(' ')
      if (!numberAppears(evidenceText, number)) {
        issues.push(`Numeric claim ${number} is not present in its cited evidence.`)
      }
    }
  }
}

function passagesForCitations(
  text: string,
  passagesByUrl: Map<string, EvidencePassage[]>,
  sourceById: Map<string, CriticalThinkingSource>
): string[] {
  return [...text.matchAll(/\[\[(S\d+)(?::(P\d+))?\]\]/g)].flatMap((citation) => {
    const source = sourceById.get(citation[1])
    const passages = source ? passagesByUrl.get(canonicalResearchUrl(source.url)) : undefined
    return (passages ?? [])
      .filter((passage) => !citation[2] || passage.id === citation[2])
      .map((passage) => passage.text)
  })
}

/** Convert validated internal IDs into deterministic clickable Markdown links. */
export function renderResearchCitations(report: string, sources: CriticalThinkingSource[]): string {
  const sourceById = new Map(trustedVerifiedSources(sources).map((source) => [source.id, source]))
  return report
    .split(/(```[\s\S]*?```)/g)
    .map((block) => {
      if (block.startsWith('```chart')) return renderChartCitation(block, sourceById)
      if (block.startsWith('```')) return block
      return block.replace(/\[\[(S\d+)(?::(P\d+))?\]\]/g, (marker, sourceId: string) => {
        const source = sourceById.get(sourceId)
        return source ? markdownCitation(source) : marker
      })
    })
    .join('')
}

function validateCitationCoverage(report: string, issues: string[]): void {
  const withoutCode = report.replace(/```[\s\S]*?```/g, '')
  for (const block of withoutCode.split(/\n\s*\n/)) {
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
    issues.push(`Material report text has no evidence citation: ${truncateIssue(prose)}`)
  }
}

function renderChartCitation(
  block: string,
  sourceById: Map<string, CriticalThinkingSource>
): string {
  const match = /^```chart\s*([\s\S]*?)```$/.exec(block)
  if (!match) return block
  try {
    const chart = JSON.parse(match[1]) as { source?: unknown }
    if (typeof chart.source !== 'string') return block
    const sourceId = /\[\[(S\d+)(?::P\d+)?\]\]/.exec(chart.source)?.[1]
    const source = sourceId ? sourceById.get(sourceId) : undefined
    if (!source) return block
    chart.source = markdownCitation(source)
    return `\`\`\`chart\n${JSON.stringify(chart)}\n\`\`\``
  } catch {
    return block
  }
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
      const chart = parseChartForValidation(JSON.parse(match[1]))
      if (!chart) {
        issues.push('A chart block does not match the supported chart schema.')
        continue
      }
      const evidenceText = passagesForCitations(chart.source, passagesByUrl, sourceById).join(' ')
      for (const value of chart.datasets.flatMap((dataset) => dataset.values)) {
        if (!chartValueAppears(evidenceText, value, chart.unit)) {
          issues.push(
            `Chart value ${value}${chart.unit ? ` ${chart.unit}` : ''} is not present with the same unit in its cited evidence passage.`
          )
        }
      }
    } catch {
      issues.push('A chart block is not valid JSON.')
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

function numberAppears(text: string, value: number | string): boolean {
  const expected = normalizeNumber(value)
  return extractNumbers(text).some((candidate) => normalizeNumber(candidate) === expected)
}

function extractNumbers(value: string): string[] {
  return (
    value.match(/\b\d+(?:,\d{3})*(?:\.\d+)?(?:%|\s+percentage\s+points?\b|\s+percent\b)?/gi) ?? []
  )
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
  return numberAppears(text, value) && normalizeQuote(text).includes(normalizeQuote(normalizedUnit))
}
