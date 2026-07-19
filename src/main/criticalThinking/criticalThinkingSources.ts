import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'

const SEARCH_RESULT_PATTERN =
  /^\d+\.\s+\*\*(.+?)\*\*\s+[\u2013\u2014-]\s+(https?:\/\/\S+)\r?\n([^\r\n]*)/gm

/** Legacy parser for persisted tool activities created before structured artifacts existed. */
export function sourcesFromSearchResult(result: string | undefined): CriticalThinkingSource[] {
  if (!result) return []
  const sources: CriticalThinkingSource[] = []
  for (const match of result.matchAll(SEARCH_RESULT_PATTERN)) {
    const source = createSource(match[1], match[2], false, match[3])
    if (source) sources.push(source)
  }
  return renumber(dedupeSources(sources))
}

/** Convert trusted tool artifacts into compact source metadata for runs.json and the UI. */
export function sourcesFromArtifact(artifact: ToolArtifact): CriticalThinkingSource[] {
  if (artifact.kind === 'web-search') {
    return renumber(
      artifact.results.flatMap((result) => {
        const source = createSource(result.title, result.url, false, result.snippet)
        return source ? [source] : []
      })
    )
  }
  const source = createSource(
    artifact.title,
    artifact.finalUrl,
    artifact.status >= 200 && artifact.status < 300 && artifact.passages.length > 0
  )
  return source ? renumber([source]) : []
}

/**
 * Merge by canonical URL. A fetched page upgrades a search lead to verified;
 * model-authored report links never enter this path.
 */
export function mergeSources(
  current: CriticalThinkingSource[],
  additions: CriticalThinkingSource[]
): CriticalThinkingSource[] {
  const merged = new Map<string, CriticalThinkingSource>()
  for (const source of [...current, ...additions]) {
    const key = canonicalUrl(source.url)
    const existing = merged.get(key)
    if (!existing || (!existing.verified && source.verified)) {
      merged.set(key, { ...source, id: '' })
    }
  }
  const prioritized = [...merged.values()].sort(
    (left, right) => Number(right.verified) - Number(left.verified)
  )
  return renumber(prioritized.slice(0, 100))
}

function createSource(
  title: string,
  rawUrl: string,
  verified: boolean,
  snippet?: string
): CriticalThinkingSource | null {
  try {
    const url = new URL(stripTrailingPunctuation(rawUrl))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return {
      id: '',
      title: title.trim() || url.hostname,
      url: url.toString(),
      snippet: snippet?.trim() || undefined,
      verified
    }
  } catch {
    return null
  }
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/, '')
}

function canonicalUrl(value: string): string {
  return value.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase()
}

function dedupeSources(sources: CriticalThinkingSource[]): CriticalThinkingSource[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    const key = canonicalUrl(source.url)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function renumber(sources: CriticalThinkingSource[]): CriticalThinkingSource[] {
  return sources.map((source, index) => ({ ...source, id: `S${index + 1}` }))
}
