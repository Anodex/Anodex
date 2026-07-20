import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { canonicalResearchUrl } from './criticalThinkingUrl'

const SEARCH_RESULT_PATTERN =
  /^\d+\.\s+\*\*(.+?)\*\*\s+[\u2013\u2014-]\s+(https?:\/\/\S+)\r?\n([^\r\n]*)/gm
export const MAX_COMPACT_SOURCES = 100
const VALID_SOURCE_ID_PATTERN = /^S([1-9]\d*)$/

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
  const merged: CriticalThinkingSource[] = []
  const indexByUrl = new Map<string, number>()
  const usedIds = new Set<string>()
  let nextNumber = nextSourceNumber(current)

  const reserveId = (preferred?: string): string => {
    if (preferred && VALID_SOURCE_ID_PATTERN.test(preferred) && !usedIds.has(preferred)) {
      usedIds.add(preferred)
      return preferred
    }
    while (usedIds.has(`S${nextNumber}`)) nextNumber += 1
    const id = `S${nextNumber}`
    nextNumber += 1
    usedIds.add(id)
    return id
  }

  for (const source of current) {
    const key = canonicalResearchUrl(source.url)
    const existingIndex = indexByUrl.get(key)
    if (existingIndex !== undefined) {
      merged[existingIndex] = mergeSourceMetadata(merged[existingIndex], source)
      continue
    }
    indexByUrl.set(key, merged.length)
    merged.push({ ...source, id: reserveId(source.id) })
  }

  for (const source of additions) {
    const key = canonicalResearchUrl(source.url)
    const existingIndex = indexByUrl.get(key)
    if (existingIndex !== undefined) {
      merged[existingIndex] = mergeSourceMetadata(merged[existingIndex], source)
      continue
    }
    if (merged.length >= MAX_COMPACT_SOURCES) {
      if (!source.verified) continue
      const unverifiedIndex = findLastUnverifiedIndex(merged)
      if (unverifiedIndex >= 0) {
        indexByUrl.delete(canonicalResearchUrl(merged[unverifiedIndex].url))
        indexByUrl.set(key, unverifiedIndex)
        merged[unverifiedIndex] = { ...source, id: reserveId() }
        continue
      }
      continue
    }
    indexByUrl.set(key, merged.length)
    merged.push({ ...source, id: reserveId() })
  }
  return merged
}

function mergeSourceMetadata(
  existing: CriticalThinkingSource,
  candidate: CriticalThinkingSource
): CriticalThinkingSource {
  if (candidate.verified && !existing.verified) {
    return {
      ...candidate,
      id: existing.id,
      snippet: candidate.snippet ?? existing.snippet,
      verified: true
    }
  }
  return {
    ...existing,
    snippet: existing.snippet ?? candidate.snippet,
    verified: existing.verified || candidate.verified
  }
}

function nextSourceNumber(sources: CriticalThinkingSource[]): number {
  let highest = 0
  for (const source of sources) {
    const match = VALID_SOURCE_ID_PATTERN.exec(source.id)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

function findLastUnverifiedIndex(sources: CriticalThinkingSource[]): number {
  for (let index = sources.length - 1; index >= 0; index--) {
    if (!sources[index].verified) return index
  }
  return -1
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

function dedupeSources(sources: CriticalThinkingSource[]): CriticalThinkingSource[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    const key = canonicalResearchUrl(source.url)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function renumber(sources: CriticalThinkingSource[]): CriticalThinkingSource[] {
  return sources.map((source, index) => ({ ...source, id: `S${index + 1}` }))
}
