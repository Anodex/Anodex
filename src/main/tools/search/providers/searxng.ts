import {
  createSearchAbortScope,
  type SearchOptions,
  type SearchProvider,
  type SearchResult
} from '../types'
import { describeSearchHttpError } from '../searchHttpError'

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
    async search(
      query: string,
      resultCount: number,
      options?: SearchOptions
    ): Promise<SearchResult[]> {
      const url = new URL(`${normalized}/search`)
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      url.searchParams.set('safesearch', '0')
      url.searchParams.set('categories', categoriesFor(options?.intent))

      const signal = options?.signal

      const abort = createSearchAbortScope(signal, FETCH_TIMEOUT_MS)

      try {
        const response = await fetch(url.toString(), {
          signal: abort.signal,
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) {
          throw new Error(describeSearchHttpError('SearXNG', response.status, response.statusText))
        }

        const data = (await response.json()) as SearxngResponse
        const results = data.results ?? []
        return results.slice(0, resultCount).map((item) => parseResult(item))
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            abort.timedOut()
              ? 'SearXNG request timed out. Is the instance running?'
              : 'SearXNG request cancelled.'
          )
        }
        throw error
      } finally {
        abort.dispose()
      }
    }
  }
}

/**
 * Which SearXNG categories to search.
 *
 * `general` alone is SearXNG's default and what an ordinary lookup wants.
 * Adding `science` is additive rather than a swap - measured on a local
 * instance, one query went from 20 results (Google only) to 75, keeping all
 * twenty and gaining arXiv, Crossref, Semantic Scholar, Google Scholar and
 * OpenAIRE. Scholarly engines live in `science` and are never consulted by a
 * default search, which is why they sat idle through every research run.
 */
function categoriesFor(intent: SearchOptions['intent']): string {
  return intent === 'scholarly' ? 'general,science' : 'general'
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
