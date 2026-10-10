import type { WebSearchSettings } from '@shared/settings.types'

/** A search service the setup offers, and what it takes to use it. */
export interface WebSearchService {
  id: Exclude<WebSearchSettings['provider'], 'none' | 'google'>
  name: string
  /** One line on cost, said plainly: this is the question people choose by. */
  cost: string
  recommended?: boolean
  /** What the person pastes: a key from the service, or the address of their own server. */
  needs: 'key' | 'url'
  /** Where to get the key, or how to run the server. Opens in the browser. */
  getUrl: string
  getLabel: string
  placeholder: string
}

/**
 * The services offered by the guided setup, recommended first.
 *
 * Tavily leads because it is the one with a free plan and no card: Brave
 * retired its free tier in February 2026, and now needs a card on file for
 * the credit it includes. Google stays in Settings only; it needs a key *and*
 * a search engine created in a second console, which is not a setup anybody
 * finishes in a dialog.
 */
export const WEB_SEARCH_SERVICES: readonly WebSearchService[] = [
  {
    id: 'tavily',
    name: 'Tavily',
    cost: 'Free plan, no card needed.',
    recommended: true,
    needs: 'key',
    getUrl: 'https://app.tavily.com/',
    getLabel: 'Get a free Tavily key',
    placeholder: 'tvly-…'
  },
  {
    id: 'brave',
    name: 'Brave Search',
    cost: 'Needs a card on file; includes some free credit each month.',
    needs: 'key',
    getUrl: 'https://api-dashboard.search.brave.com/',
    getLabel: 'Get a Brave Search key',
    placeholder: 'Brave Search API key'
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    cost: 'Free. You run it yourself, on this computer or a server.',
    needs: 'url',
    getUrl: 'https://docs.searxng.org/admin/installation.html',
    getLabel: 'How to run SearXNG',
    placeholder: 'http://localhost:8080'
  }
]
