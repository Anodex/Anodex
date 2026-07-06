/** A single search result returned to the model. */
export interface SearchResult {
  /** Result title. */
  title: string
  /** Result URL. */
  url: string
  /** Short snippet or description. */
  snippet: string
}

/** Abstraction over every web search backend Anodex supports. */
export interface SearchProvider {
  /** Perform a search and return a bounded list of results. */
  search(query: string, resultCount: number): Promise<SearchResult[]>
}

/** Normalise a result count to a provider-safe integer. */
export function clampResultCount(value: number, max = 10): number {
  const parsed = Number.isFinite(value) ? Math.floor(value) : 5
  return Math.max(1, Math.min(parsed, max))
}
