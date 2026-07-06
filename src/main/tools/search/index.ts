import type { WebSearchSettings } from '@shared/settings.types'
import type { SearchProvider } from './types'
import { clampResultCount } from './types'
import { createSearxngProvider } from './providers/searxng'
import { createBraveProvider } from './providers/brave'
import { createTavilyProvider } from './providers/tavily'
import { createGoogleProvider } from './providers/google'

export type { SearchProvider, SearchResult } from './types'
export { clampResultCount }

/**
 * Build a search provider from the user's settings, or null if search is disabled.
 *
 * Validation happens eagerly so the model gets a clear error message instead of
 * a silent failure.
 */
export function createSearchProvider(settings: WebSearchSettings): SearchProvider | null {
  const resultCount = clampResultCount(settings.resultCount)

  switch (settings.provider) {
    case 'none':
      return null
    case 'searxng': {
      const baseUrl = settings.baseUrl.trim() || 'http://localhost:8080'
      return wrapWithCount(createSearxngProvider(baseUrl), resultCount)
    }
    case 'brave': {
      if (!settings.apiKey.trim()) throw new Error('Brave Search requires an API key.')
      return wrapWithCount(createBraveProvider(settings.apiKey.trim()), resultCount)
    }
    case 'tavily': {
      if (!settings.apiKey.trim()) throw new Error('Tavily requires an API key.')
      return wrapWithCount(createTavilyProvider(settings.apiKey.trim()), resultCount)
    }
    case 'google': {
      if (!settings.apiKey.trim())
        throw new Error('Google Programmable Search requires an API key.')
      if (!settings.searchEngineId.trim()) {
        throw new Error('Google Programmable Search requires a Search Engine ID.')
      }
      return wrapWithCount(
        createGoogleProvider(settings.apiKey.trim(), settings.searchEngineId.trim()),
        resultCount
      )
    }
    default:
      return null
  }
}

/**
 * Wrap a provider so the per-call count is honoured (clamped to a safe range)
 * and falls back to the user's configured default when the caller omits it.
 */
function wrapWithCount(provider: SearchProvider, defaultCount: number): SearchProvider {
  return {
    search(query: string, resultCount?: number) {
      return provider.search(query, clampResultCount(resultCount ?? defaultCount))
    }
  }
}
