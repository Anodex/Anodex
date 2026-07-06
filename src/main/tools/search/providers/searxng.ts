import type { SearchProvider, SearchResult } from '../types'

const FETCH_TIMEOUT_MS = 30_000
const MAX_SNIPPET_LENGTH = 500

interface SearxngResult {
  title?: string
  url?: string
  content?: string
  abstract?: string
}

interface SearxngResponse {
  results?: SearxngResult[]
}

/**
 * SearXNG search provider.
 *
 * SearXNG is a self-hosted, privacy-respecting metasearch engine. Because the
 * instance is run by the user, no API key is required.
 */
export function createSearxngProvider(baseUrl: string): SearchProvider {
  const normalized = baseUrl.replace(/\/$/, '')

  return {
    async search(query: string, resultCount: number): Promise<SearchResult[]> {
      const url = new URL(`${normalized}/search`)
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      url.searchParams.set('safesearch', '0')

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      try {
        const response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { Accept: 'application/json' }
        })
        clearTimeout(timeout)

        if (!response.ok) {
          throw new Error(`SearXNG returned HTTP ${response.status}: ${response.statusText}`)
        }

        const data = (await response.json()) as SearxngResponse
        const results = data.results ?? []
        return results.slice(0, resultCount).map((item) => parseResult(item))
      } catch (error) {
        clearTimeout(timeout)
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('SearXNG request timed out. Is the instance running?')
        }
        throw error
      }
    }
  }
}

function parseResult(result: SearxngResult): SearchResult {
  return {
    title: result.title ?? '',
    url: result.url ?? '',
    snippet: truncate(result.content ?? result.abstract ?? '')
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_SNIPPET_LENGTH) return text
  return `${text.slice(0, MAX_SNIPPET_LENGTH)}…`
}
