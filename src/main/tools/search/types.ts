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
  search(query: string, resultCount: number, signal?: AbortSignal): Promise<SearchResult[]>
}

export interface SearchAbortScope {
  signal: AbortSignal
  timedOut: () => boolean
  dispose: () => void
}

const MAX_SEARCH_TITLE_CHARS = 300
const MAX_SEARCH_URL_CHARS = 4_096
const MAX_SEARCH_SNIPPET_CHARS = 500

/** Bound and validate untrusted provider JSON before it enters artifacts or prompts. */
export function sanitizeSearchResults(value: unknown, limit: number): SearchResult[] {
  if (!Array.isArray(value)) return []
  const boundedLimit = clampResultCount(limit)
  const results: SearchResult[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const rawUrl = normalizedString(candidate.url)
    if (!rawUrl || rawUrl.length > MAX_SEARCH_URL_CHARS) continue
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      continue
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password
    ) {
      continue
    }
    results.push({
      title: boundedString(candidate.title, MAX_SEARCH_TITLE_CHARS) ?? parsed.hostname,
      url: rawUrl,
      snippet: boundedString(candidate.snippet, MAX_SEARCH_SNIPPET_CHARS) ?? ''
    })
    if (results.length >= boundedLimit) break
  }
  return results
}

/** Combine a provider timeout with a caller's Stop signal without leaking listeners. */
export function createSearchAbortScope(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number
): SearchAbortScope {
  const controller = new AbortController()
  let didTimeOut = false
  const onOuterAbort = (): void => controller.abort()
  if (outerSignal?.aborted) controller.abort()
  else outerSignal?.addEventListener('abort', onOuterAbort, { once: true })
  const timeout = setTimeout(() => {
    didTimeOut = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timeout)
      outerSignal?.removeEventListener('abort', onOuterAbort)
    }
  }
}

/** Normalise a result count to a provider-safe integer. */
export function clampResultCount(value: number, max = 10): number {
  const parsed = Number.isFinite(value) ? Math.floor(value) : 5
  return Math.max(1, Math.min(parsed, max))
}

function boundedString(value: unknown, maxChars: number): string | null {
  const text = normalizedString(value)
  if (!text) return null
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
