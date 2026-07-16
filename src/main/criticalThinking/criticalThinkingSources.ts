import type { CriticalThinkingSource } from '@shared/criticalThinking.types'

const SEARCH_RESULT_PATTERN =
  /^\d+\.\s+\*\*(.+?)\*\*\s+[\u2013\u2014-]\s+(https?:\/\/\S+)\r?\n([^\r\n]*)/gm
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

/** Extract structured sources from the stable model-facing output of `web_search`. */
export function sourcesFromSearchResult(result: string | undefined): CriticalThinkingSource[] {
  if (!result) return []
  const sources: CriticalThinkingSource[] = []
  for (const match of result.matchAll(SEARCH_RESULT_PATTERN)) {
    const source = createSource(match[1], match[2], match[3])
    if (source) sources.push(source)
  }
  return dedupeSources(sources)
}

/** Pick up citations the model included directly in the final report. */
export function sourcesFromReport(report: string): CriticalThinkingSource[] {
  const sources: CriticalThinkingSource[] = []
  for (const match of report.matchAll(MARKDOWN_LINK_PATTERN)) {
    const source = createSource(match[1], match[2])
    if (source) sources.push(source)
  }
  return dedupeSources(sources)
}

export function mergeSources(
  current: CriticalThinkingSource[],
  additions: CriticalThinkingSource[]
): CriticalThinkingSource[] {
  return dedupeSources([...current, ...additions]).slice(0, 100)
}

function createSource(
  title: string,
  rawUrl: string,
  snippet?: string
): CriticalThinkingSource | null {
  try {
    const url = new URL(stripTrailingPunctuation(rawUrl))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return {
      title: title.trim() || url.hostname,
      url: url.toString(),
      snippet: snippet?.trim() || undefined
    }
  } catch {
    return null
  }
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/, '')
}

function dedupeSources(sources: CriticalThinkingSource[]): CriticalThinkingSource[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    const key = source.url.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
