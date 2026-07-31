/**
 * Web sources attributed to a single assistant turn.
 *
 * This is the chat-surface counterpart to `CriticalThinkingSource`: the same
 * lead-vs-verified distinction, deliberately kept as its own type because the
 * two travel on different objects (a `ChatMessage` here, a run's step state
 * there) and carry different id conventions. Critical Thinking numbers sources
 * per report; chat numbers them per turn.
 */
export interface WebSource {
  /** Stable per-turn id the model cites, always `S` followed by a positive integer. */
  id: string
  title: string
  url: string
  /** Search-result snippet, when the source arrived as a search lead. */
  snippet?: string
  /**
   * True only once `fetch_url` actually retrieved readable passages from this
   * URL. A `web_search` hit alone is a lead: the model has seen a title and a
   * snippet, not the page. The distinction is the whole point of showing
   * sources at all — an answer built only on leads is weaker than one built on
   * fetched text, and the reader deserves to see which they have.
   */
  verified: boolean
}

/** Marker the model writes inline to attribute a claim, e.g. `[S2]`. */
export const WEB_SOURCE_MARKER_PATTERN = /\[(S[1-9]\d*)\]/g

/** A single well-formed source id, anchored. */
export const WEB_SOURCE_ID_PATTERN = /^S[1-9]\d*$/
