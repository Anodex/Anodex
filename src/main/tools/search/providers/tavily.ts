import type { SearchProvider, SearchResult } from '../types'

const API_URL = 'https://api.tavily.com/search'
const FETCH_TIMEOUT_MS = 30_000
const MAX_SNIPPET_LENGTH = 500

interface TavilyResult {
  title?: string
  url?: string
  content?: string
  snippet?: string
}

interface TavilyResponse {
  results?: TavilyResult[]
}

/**
 * Tavily search provider.
 *
 * Built for AI agents. Free tier: 1,000 API calls/month.
 * Requires an API key from https://tavily.com/
 */
export function createTavilyProvider(apiKey: string): SearchProvider {
  return {
    async search(query: string, resultCount: number): Promise<SearchResult[]> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: resultCount,
            search_depth: 'basic',
            include_answer: false,
            include_images: false,
            include_raw_content: false
          })
        })
        clearTimeout(timeout)

        if (!response.ok) {
          throw new Error(`Tavily returned HTTP ${response.status}: ${response.statusText}`)
        }

        const data = (await response.json()) as TavilyResponse
        const results = data.results ?? []
        return results.slice(0, resultCount).map((item) => parseResult(item))
      } catch (error) {
        clearTimeout(timeout)
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Tavily request timed out.')
        }
        throw error
      }
    }
  }
}

function parseResult(result: TavilyResult): SearchResult {
  return {
    title: result.title ?? '',
    url: result.url ?? '',
    snippet: truncate(result.content ?? result.snippet ?? '')
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_SNIPPET_LENGTH) return text
  return `${text.slice(0, MAX_SNIPPET_LENGTH)}…`
}
