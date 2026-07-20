import { createSearchAbortScope, type SearchProvider, type SearchResult } from '../types'

const API_URL = 'https://www.googleapis.com/customsearch/v1'
const FETCH_TIMEOUT_MS = 30_000
const MAX_SNIPPET_LENGTH = 500

interface GoogleItem {
  title?: string
  link?: string
  snippet?: string
}

interface GoogleResponse {
  items?: GoogleItem[]
}

/**
 * Google Programmable Search provider.
 *
 * Free tier: 100 queries/day.
 * Requires an API key and a Custom Search Engine ID.
 */
export function createGoogleProvider(apiKey: string, searchEngineId: string): SearchProvider {
  return {
    async search(
      query: string,
      resultCount: number,
      signal?: AbortSignal
    ): Promise<SearchResult[]> {
      const url = new URL(API_URL)
      url.searchParams.set('key', apiKey)
      url.searchParams.set('cx', searchEngineId)
      url.searchParams.set('q', query)
      url.searchParams.set('num', String(Math.min(resultCount, 10)))

      const abort = createSearchAbortScope(signal, FETCH_TIMEOUT_MS)

      try {
        const response = await fetch(url.toString(), {
          signal: abort.signal,
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) {
          throw new Error(`Google returned HTTP ${response.status}: ${response.statusText}`)
        }

        const data = (await response.json()) as GoogleResponse
        const items = data.items ?? []
        return items.slice(0, resultCount).map((item) => parseResult(item))
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            abort.timedOut() ? 'Google request timed out.' : 'Google request cancelled.'
          )
        }
        throw error
      } finally {
        abort.dispose()
      }
    }
  }
}

function parseResult(result: GoogleItem): SearchResult {
  return {
    title: result.title ?? '',
    url: result.link ?? '',
    snippet: truncate(result.snippet ?? '')
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_SNIPPET_LENGTH) return text
  return `${text.slice(0, MAX_SNIPPET_LENGTH)}…`
}
