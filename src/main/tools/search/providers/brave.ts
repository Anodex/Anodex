import type { SearchProvider, SearchResult } from '../types'

const API_URL = 'https://api.search.brave.com/res/v1/web/search'
const FETCH_TIMEOUT_MS = 30_000
const MAX_SNIPPET_LENGTH = 500

interface BraveWebResult {
  title?: string
  url?: string
  description?: string
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[]
  }
}

/**
 * Brave Search API provider.
 *
 * Free tier: 2,000 queries/month.
 * Requires an API key from https://api.search.brave.com/
 */
export function createBraveProvider(apiKey: string): SearchProvider {
  return {
    async search(query: string, resultCount: number): Promise<SearchResult[]> {
      const url = new URL(API_URL)
      url.searchParams.set('q', query)
      url.searchParams.set('count', String(resultCount))
      url.searchParams.set('offset', '0')

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      try {
        const response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': apiKey
          }
        })
        clearTimeout(timeout)

        if (!response.ok) {
          throw new Error(`Brave returned HTTP ${response.status}: ${response.statusText}`)
        }

        const data = (await response.json()) as BraveResponse
        const results = data.web?.results ?? []
        return results.slice(0, resultCount).map((item) => parseResult(item))
      } catch (error) {
        clearTimeout(timeout)
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Brave request timed out.')
        }
        throw error
      }
    }
  }
}

function parseResult(result: BraveWebResult): SearchResult {
  return {
    title: result.title ?? '',
    url: result.url ?? '',
    snippet: truncate(result.description ?? '')
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_SNIPPET_LENGTH) return text
  return `${text.slice(0, MAX_SNIPPET_LENGTH)}…`
}
