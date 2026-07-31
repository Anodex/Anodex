import { canonicalUrl } from '@shared/canonicalUrl'
import type { WebSource } from '@shared/webSources.types'

/** Hard ceiling on sources tracked for one turn, so a runaway search loop can't grow unbounded. */
const MAX_SOURCES_PER_TURN = 60

/**
 * Per-turn registry of the web sources an assistant answer is standing on.
 *
 * One of these is created for each generation and handed to the web tools
 * through `ToolRuntimeContext`. It exists to solve one problem: the model has
 * to be able to attribute a claim to a source, and it can only do that if the
 * id it sees in a tool result is stable for the whole turn. So ids are minted
 * here, once per distinct URL, and the same registry is read afterwards to
 * attach the source list to the finished message.
 *
 * Identity is the canonical URL, not the title — the same page reached from
 * two searches is one source with one id, and a later `fetch_url` of a URL
 * already seen as a search lead upgrades that entry to verified in place
 * rather than creating a second one.
 */
export class WebSourceRegistry {
  private readonly byUrl = new Map<string, WebSource>()
  private attempts = 0

  /**
   * Note that a web tool ran, whether or not it produced anything.
   *
   * This is what separates "the model never looked" from "the model looked and
   * came back empty" — the second case is the one the reader has to be told
   * about, and no source list can express it because there are no sources.
   */
  recordAttempt(): void {
    this.attempts += 1
  }

  /** True if any web tool ran during this turn. */
  get attempted(): boolean {
    return this.attempts > 0
  }

  /**
   * Register a source and return its stable per-turn id, or null once the turn
   * ceiling is reached. Re-registering a known URL returns the original id;
   * passing `verified` for a URL previously seen as a lead upgrades it.
   */
  register(input: {
    title: string
    url: string
    snippet?: string
    verified: boolean
  }): string | null {
    const normalized = normalizeUrl(input.url)
    if (!normalized) return null

    const key = canonicalUrl(normalized)
    const existing = this.byUrl.get(key)
    if (existing) {
      if (input.verified && !existing.verified) existing.verified = true
      if (!existing.snippet && input.snippet?.trim()) existing.snippet = input.snippet.trim()
      // A fetched page's real <title> beats a search result's, which is often
      // the provider's own rewrite of it.
      if (input.verified && input.title.trim()) existing.title = input.title.trim()
      return existing.id
    }

    if (this.byUrl.size >= MAX_SOURCES_PER_TURN) return null

    const source: WebSource = {
      id: `S${this.byUrl.size + 1}`,
      title: input.title.trim() || hostOf(normalized),
      url: normalized,
      snippet: input.snippet?.trim() || undefined,
      verified: input.verified
    }
    this.byUrl.set(key, source)
    return source.id
  }

  /** Every source registered this turn, in the order the model first saw them. */
  list(): WebSource[] {
    return [...this.byUrl.values()].map((source) => ({ ...source }))
  }

  /** True once at least one source was actually fetched, not merely found. */
  hasVerified(): boolean {
    return [...this.byUrl.values()].some((source) => source.verified)
  }
}

/** Accept only http(s), and drop the fragment — it never identifies a distinct page. */
function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim().replace(/[.,;:!?]+$/, ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
