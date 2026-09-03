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
  /**
   * Engines that did not answer, as `[name, reason]`. SearXNG drops a throttled
   * engine from the response rather than failing the request, so this is the
   * only signal that a thin result set is degradation rather than an absence.
   */
  unresponsive_engines?: [string, string][]
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
        const unresponsive = (data.unresponsive_engines ?? []).map(([engine]) => engine)

        // Empty *and* degraded is the dangerous case. SearXNG has no index of
        // its own - every query is forwarded to Google, Brave, DuckDuckGo and
        // the rest from the user's IP - and a throttled engine is dropped from
        // the response rather than failing it. The caller then reports "No web
        // results found", which reads exactly like "the evidence does not
        // exist" and is the one failure here that produces a confidently wrong
        // answer rather than a visible error.
        //
        // Measured on one machine: five of eight engines suspended, every
        // result coming from Google alone. One CAPTCHA away from zero.
        //
        // Only when empty: a partial result set is still usable evidence, and
        // discarding it would trade a quiet failure for a loud one.
        if (results.length === 0 && unresponsive.length > 0) {
          throw new Error(
            `SearXNG returned no results, but ${unresponsive.length} engine(s) did not answer ` +
              `(${unresponsive.join(', ')}). Treat this as a degraded search rather than an ` +
              `absence of evidence, and retry or check the instance.`
          )
        }

        return results.slice(0, resultCount).map((item) => parseResult(item))
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            abort.timedOut()
              ? 'SearXNG request timed out. Is the instance running?'
              : 'SearXNG request cancelled.'
          )
        }
        // A refused connection is the commonest way a self-hosted instance
        // fails, and it arrived as a bare "fetch failed" — which says nothing
        // and reads like a bug in Anodex.
        //
        // Measured: a Critical Thinking run executed all six steps against a
        // SearXNG that was not running, finished `partial` with zero sources
        // and zero evidence, and logged no warning or error at all. The only
        // clue was the run's own closing line, "Research finished without a
        // fetched source". A timeout already says "Is the instance running?";
        // a refusal is the same question with a more certain answer.
        if (isConnectionRefused(error)) {
          throw new Error(
            `SearXNG is not reachable at ${baseUrl}. The instance does not appear to be running — ` +
              'start it, or choose a different search provider in Settings.'
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

/**
 * Whether a fetch failure was the connection being refused.
 *
 * `fetch` reports these as a plain `TypeError: fetch failed` and hides the
 * reason on `cause`, so the code has to be dug out rather than matched on the
 * message — which differs between runtimes and locales.
 */
function isConnectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | null)?.cause
  const code = cause?.code
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET'
}
