import { describe, expect, it, vi } from 'vitest'
import { createSearchProvider } from '../search'
import { webSearchTool } from '../webSearchTools'
import { createMockContext, createMockDefine } from './test-helpers'

describe('web search providers', () => {
  it('creates a SearXNG provider and parses results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          results: [
            { title: 'A', url: 'https://a.test', content: 'snippet a' },
            { title: 'B', url: 'https://b.test', abstract: 'snippet b' }
          ]
        })
    })

    const provider = createSearchProvider({
      provider: 'searxng',
      apiKey: '',
      searchEngineId: '',
      baseUrl: 'http://localhost:8080',
      resultCount: 5,
      requireApproval: false
    })

    expect(provider).not.toBeNull()
    const results = await provider!.search('hello', 2)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ title: 'A', url: 'https://a.test', snippet: 'snippet a' })
    expect(results[1]).toEqual({ title: 'B', url: 'https://b.test', snippet: 'snippet b' })
  })

  it('creates a Brave provider and parses results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          web: {
            results: [{ title: 'Brave result', url: 'https://brave.test', description: 'desc' }]
          }
        })
    })

    const provider = createSearchProvider({
      provider: 'brave',
      apiKey: 'key',
      searchEngineId: '',
      baseUrl: '',
      resultCount: 3,
      requireApproval: false
    })

    const results = await provider!.search('hello', 1)
    expect(results[0].title).toBe('Brave result')
  })

  it('creates a Tavily provider and parses results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          results: [{ title: 'Tavily result', url: 'https://tavily.test', content: 'content' }]
        })
    })

    const provider = createSearchProvider({
      provider: 'tavily',
      apiKey: 'key',
      searchEngineId: '',
      baseUrl: '',
      resultCount: 3,
      requireApproval: false
    })

    const results = await provider!.search('hello', 1)
    expect(results[0].title).toBe('Tavily result')
  })

  it('creates a Google provider and parses results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          items: [{ title: 'Google result', link: 'https://google.test', snippet: 'snippet' }]
        })
    })

    const provider = createSearchProvider({
      provider: 'google',
      apiKey: 'key',
      searchEngineId: 'cx',
      baseUrl: '',
      resultCount: 3,
      requireApproval: false
    })

    const results = await provider!.search('hello', 1)
    expect(results[0].url).toBe('https://google.test')
  })

  it('returns null for disabled provider', () => {
    const provider = createSearchProvider({
      provider: 'none',
      apiKey: '',
      searchEngineId: '',
      baseUrl: '',
      resultCount: 5,
      requireApproval: false
    })
    expect(provider).toBeNull()
  })

  it('throws for missing API key', () => {
    expect(() =>
      createSearchProvider({
        provider: 'brave',
        apiKey: '',
        searchEngineId: '',
        baseUrl: '',
        resultCount: 5,
        requireApproval: false
      })
    ).toThrow('API key')
  })
})

describe('web_search tool', () => {
  it('formats search results for the model', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          results: [{ title: 'Result', url: 'https://example.com', content: 'Snippet' }]
        })
    })

    const ctx = createMockContext('/tmp/workspace')
    ctx.webSearch = {
      provider: 'searxng',
      apiKey: '',
      searchEngineId: '',
      baseUrl: 'http://localhost:8080',
      resultCount: 5,
      requireApproval: false
    }

    const tool = webSearchTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { query: string }) => Promise<string>
    }
    const result = await tool.handler({ query: 'hello world' })

    expect(result).toContain('Result')
    expect(result).toContain('https://example.com')
    expect(result).toContain('Snippet')
  })

  it('truncates a large formatted result set and reports the real total size', async () => {
    // Many results with long snippets — far more than the shared 4000-char
    // model-result cap. Guards against the same double-truncation bug found
    // and fixed in read_file/run_command/git_diff/fetch_url: this tool used
    // to also cap at its own, larger, redundant 8000-char threshold, which
    // the outer cap always overrode anyway while reporting a meaningless
    // intermediate length.
    // Note: result count is separately clamped to 10 (`clampResultCount`,
    // `search/types.ts`) regardless of what's configured below, and each
    // snippet is separately capped at 500 chars by the SearXNG provider
    // itself (`MAX_SNIPPET_LENGTH`) — 480-char snippets across the 10
    // results that actually come through are what push the *formatted*
    // total past the model-result cap, not the requested 50.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          results: Array.from({ length: 50 }, (_, i) => ({
            title: `Result ${i}`,
            url: `https://example.com/${i}`,
            content: 'x'.repeat(480)
          }))
        })
    })

    const ctx = createMockContext('/tmp/workspace')
    ctx.webSearch = {
      provider: 'searxng',
      apiKey: '',
      searchEngineId: '',
      baseUrl: 'http://localhost:8080',
      resultCount: 50,
      requireApproval: false
    }

    const tool = webSearchTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { query: string }) => Promise<string>
    }
    const result = await tool.handler({ query: 'hello world' })

    expect(result.length).toBeLessThan(4100)
    expect(result).toMatch(/truncated, \d+ bytes total/)
  })
})
