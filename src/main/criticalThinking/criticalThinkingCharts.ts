interface ChartSelection {
  charts: unknown[]
}

/** Parse the grammar-constrained selection and return renderer-ready chart blocks. */
export function parseCriticalThinkingChartSelection(content: string): string[] | null {
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
      if (!isChartSelection(parsed)) continue
      return parsed.charts.slice(0, 2).flatMap((chart) => {
        const serialized = JSON.stringify(chart)
        return serialized.includes('```') ? [] : [`\`\`\`chart\n${serialized}\n\`\`\``]
      })
    } catch {
      // Try another bounded representation.
    }
  }
  return null
}

export function appendCriticalThinkingCharts(report: string, charts: string[]): string {
  if (charts.length === 0) return report
  const section = ['## Evidence Charts', '', ...charts].join('\n\n')
  // Tested against undefined rather than falsiness: a heading found at index 0
  // is a real match, and `!0` would send it down the append-at-end path.
  const insertion = /^## Limits and Open Questions\s*$/im.exec(report)
  const withCharts =
    insertion?.index === undefined
      ? `${report.trim()}\n\n${section}`
      : `${report.slice(0, insertion.index).trimEnd()}\n\n${section}\n\n${report.slice(insertion.index)}`
  return addChartSourcesToBibliography(withCharts, charts)
}

export function reportHasEvidenceChart(report: string): boolean {
  return /```chart\s*[\s\S]*?```/.test(report)
}

export function reportHasQuantitativeProse(report: string): boolean {
  const prose = report
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[\[S\d+(?::P\d+)?\]\]/g, '')
    .split('\n')
    .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
    .join('\n')
  return /\b\d+(?:,\d{3})*(?:\.\d+)?(?:%|\s+(?:percent|micrograms?|milligrams?|seconds?|minutes?|hours?))?\b/i.test(
    prose
  )
}

function isChartSelection(value: unknown): value is ChartSelection {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).charts)
  )
}

function addChartSourcesToBibliography(report: string, charts: string[]): string {
  const chartSourceIds = [
    ...new Set(
      charts.flatMap((chart) =>
        [...chart.matchAll(/\[\[(S\d+)(?::P\d+)?\]\]/g)].map((match) => match[1])
      )
    )
  ]
  if (chartSourceIds.length === 0) return report
  const sourceHeading = /^## Sources\s*$/im.exec(report)
  if (sourceHeading?.index === undefined) return report
  const bodyStart = sourceHeading.index + sourceHeading[0].length
  const followingHeading = /^##\s+/m.exec(report.slice(bodyStart))
  const bodyEnd = followingHeading ? bodyStart + followingHeading.index : report.length
  const sourceBody = report.slice(bodyStart, bodyEnd)
  const missing = chartSourceIds
    .filter((id) => !new RegExp(`\\[\\[${id}(?::P\\d+)?\\]\\]`).test(sourceBody))
    .map((id) => `[[${id}]]`)
  if (missing.length === 0) return report
  return `${report.slice(0, bodyEnd).trimEnd()} ${missing.join(' ')}\n\n${report.slice(bodyEnd).trimStart()}`
}
