import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSearxngProvider } from '../providers/searxng'
import { createTavilyProvider } from '../providers/tavily'
import { createBraveProvider } from '../providers/brave'
import { createGoogleProvider } from '../providers/google'
import type { SearchProvider } from '../types'

/**
 * A search backend cannot tell a research question from a lookup, but Anodex
 * can — and the difference decides which sources are consulted.
 *
 * Measured on a live local SearXNG: the same query returns 20 results from
 * Google alone under the default `general` category, and 75 under
 * `general,science` — the extra 55 coming from arXiv, Crossref, Semantic
 * Scholar, Google Scholar and OpenAIRE, and including the meta-analyses the
 * question was actually asking for. Purely additive: every general result is
 * still there.
 *
 * So every Critical Thinking run to date has done its research on Google web
 * results while the scholarly engines configured for exactly that purpose were
 * never queried. The intent has to come from the caller, because it is the only
 * one that knows.
 *
 * Providers that cannot express the distinction ignore it and behave exactly as
 * before — that is the point of a default, not a gap.
 */

/** The URL a provider actually requested, whichever `fetch` form it used. */
function requestedUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function captureRequest(): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = vi.fn((input: Parameters<typeof fetch>[0]) => {
    calls.push(requestedUrl(input))
    // Empty but well-formed for all four backends, so each parses and returns.
    return Promise.resolve(
      new Response(JSON.stringify({ results: [], items: [], web: { results: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  })
  return { calls, restore: () => (globalThis.fetch = original) }
}

afterEach(() => vi.restoreAllMocks())

describe('SearXNG search intent', () => {
  it('asks for the general category by default', async () => {
    const { calls, restore } = captureRequest()
    try {
      await createSearxngProvider('http://localhost:8080').search('typescript error', 5)
    } finally {
      restore()
    }
    const url = new URL(calls[0])
    // Either unset (SearXNG's own default is general) or explicitly general —
    // what must not happen is science leaking into an ordinary lookup.
    expect(url.searchParams.get('categories') ?? 'general').toBe('general')
  })

  it('adds the science category for a scholarly query, without dropping general', async () => {
    const { calls, restore } = captureRequest()
    try {
      await createSearxngProvider('http://localhost:8080').search('minimum wage meta-analysis', 5, {
        intent: 'scholarly'
      })
    } finally {
      restore()
    }
    const categories = new URL(calls[0]).searchParams.get('categories')
    expect(categories).toBeTruthy()
    // General must survive: the measured behaviour is additive, and dropping it
    // would trade 20 web results for scholarly ones rather than gaining them.
    expect(categories).toContain('general')
    expect(categories).toContain('science')
  })
})

describe('providers that cannot express intent', () => {
  const cases: { name: string; make: () => SearchProvider }[] = [
    { name: 'Tavily', make: () => createTavilyProvider('key') },
    { name: 'Brave', make: () => createBraveProvider('key') },
    { name: 'Google', make: () => createGoogleProvider('key', 'cx') }
  ]

  for (const { name, make } of cases) {
    it(`${name} accepts a scholarly intent and behaves as before`, async () => {
      const plain = captureRequest()
      try {
        await make().search('minimum wage meta-analysis', 5)
      } finally {
        plain.restore()
      }

      const scholarly = captureRequest()
      try {
        await make().search('minimum wage meta-analysis', 5, { intent: 'scholarly' })
      } finally {
        scholarly.restore()
      }

      // Identical request: ignoring an intent it cannot express is correct, and
      // must not become an error or a silently different search.
      expect(scholarly.calls[0]).toBe(plain.calls[0])
    })
  }
})

describe('the abort signal survives the options move', () => {
  it('still cancels a SearXNG search', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      createSearxngProvider('http://localhost:8080').search('anything', 5, {
        signal: controller.signal
      })
    ).rejects.toThrow(/cancelled/i)
  })
})

/**
 * A degraded search must not read as an absent literature.
 *
 * SearXNG has no index: every query is forwarded to Google, Brave, DuckDuckGo
 * and the rest from the user's own IP, and a throttled engine is dropped from
 * the response rather than failing it. The result is `HTTP 200` carrying fewer
 * results — or none — which downstream reads exactly like "the evidence does
 * not exist". That is the one failure class that produces a confidently wrong
 * report instead of a visible error.
 *
 * Measured on this machine: five of the eight configured engines are suspended
 * (Brave "too many requests", DuckDuckGo and Startpage CAPTCHA, Mojeek access
 * denied, Wikipedia rate limited), and every result now comes from Google
 * alone. The response says so in `unresponsive_engines`, and Anodex was
 * throwing that away.
 */
describe('SearXNG degraded search', () => {
  function respondWith(body: unknown): () => void {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    )
    return () => (globalThis.fetch = original)
  }

  it('says the search was degraded when it returns nothing and engines were down', async () => {
    const restore = respondWith({
      results: [],
      unresponsive_engines: [
        ['brave', 'Suspended: too many requests'],
        ['duckduckgo', 'CAPTCHA']
      ]
    })
    try {
      await expect(
        createSearxngProvider('http://localhost:8080').search('a real topic', 5)
      ).rejects.toThrow(/brave/i)
    } finally {
      restore()
    }
  })

  it('reports no results plainly when every engine answered', async () => {
    // A genuinely empty result set is information, and must not be dressed up
    // as a failure: the caller distinguishes them.
    const restore = respondWith({ results: [], unresponsive_engines: [] })
    try {
      const results = await createSearxngProvider('http://localhost:8080').search('a real topic', 5)
      expect(results).toEqual([])
    } finally {
      restore()
    }
  })

  it('returns results it did get, even with some engines down', async () => {
    // Partial degradation still yields usable evidence; discarding it would
    // trade a quiet failure for a loud one and lose the work.
    const restore = respondWith({
      results: [{ title: 'A paper', url: 'https://example.com/a', content: 'text' }],
      unresponsive_engines: [['brave', 'Suspended: too many requests']]
    })
    try {
      const results = await createSearxngProvider('http://localhost:8080').search('a topic', 5)
      expect(results).toHaveLength(1)
    } finally {
      restore()
    }
  })
})
