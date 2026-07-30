import { describe, expect, it, vi } from 'vitest'
import { createSearchProvider } from '../search'
import { webSearchTool } from '../webSearchTools'
import { WebSourceRegistry } from '../WebSourceRegistry'
import { sourcesFromSearchResult } from '../../criticalThinking/criticalThinkingSources'
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

  it('bounds provider metadata and drops unusable result URLs', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          web: {
            results: [
              {
                title: `  ${'T'.repeat(400)}\n`,
                url: 'https://bounded.example/report',
                description: 'S'.repeat(700)
              },
              { title: 'Unsafe', url: 'javascript:alert(1)', description: 'drop me' },
              { title: 'Credentials', url: 'https://user:secret@example.com', description: 'drop' },
              {
                title: 'Oversized URL',
                url: `https://example.com/${'x'.repeat(5_000)}`,
                description: 'drop'
              }
            ]
          }
        })
    })
    const provider = createSearchProvider({
      provider: 'brave',
      apiKey: 'key',
      searchEngineId: '',
      baseUrl: '',
      resultCount: 5,
      requireApproval: false
    })

    const results = await provider!.search('bounded', 5)

    expect(results).toHaveLength(1)
    expect(results[0].title.length).toBe(300)
    expect(results[0].snippet.length).toBe(500)
    expect(results[0].url).toBe('https://bounded.example/report')
  })

  it('forwards caller cancellation through the configured provider wrapper', async () => {
    let observedSignal: AbortSignal | undefined
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true }
        )
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
    const controller = new AbortController()

    const pending = provider!.search('hello', 1, controller.signal)
    controller.abort()

    await expect(pending).rejects.toThrow('Brave request cancelled.')
    expect(observedSignal?.aborted).toBe(true)
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
    const artifacts: unknown[] = []
    ctx.recordArtifact = (artifact) => artifacts.push(artifact)
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
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      kind: 'web-search',
      query: 'hello world',
      provider: 'searxng'
    })
  })

  it('registers each result and tells the model the id to cite', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          results: [
            { title: 'First', url: 'https://a.example/1', content: 'One' },
            { title: 'Second', url: 'https://b.example/2', content: 'Two' }
          ]
        })
    })

    const ctx = createMockContext('/tmp/workspace')
    const registry = new WebSourceRegistry()
    ctx.webSources = registry
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
    const result = await tool.handler({ query: 'news' })

    expect(result).toContain('Cite as [S1]')
    expect(result).toContain('Cite as [S2]')
    expect(registry.list().map((source) => source.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2'
    ])
    // A search hit is a lead until the page itself is fetched.
    expect(registry.hasVerified()).toBe(false)
    expect(registry.attempted).toBe(true)
  })

  it('keeps the legacy result line shape intact for the research parser', async () => {
    // criticalThinkingSources' legacy parser matches `N. **title** — url\nsnippet`
    // on persisted activities, so the citation hint has to live on its own line
    // below the snippet rather than anywhere in those two.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          results: [{ title: 'Result', url: 'https://example.com/a', content: 'Snippet' }]
        })
    })

    const ctx = createMockContext('/tmp/workspace')
    ctx.webSources = new WebSourceRegistry()
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
    const result = await tool.handler({ query: 'q' })

    expect(result).toContain('1. **Result** — https://example.com/a\nSnippet\nCite as [S1]')
    expect(sourcesFromSearchResult(result)).toMatchObject([
      { title: 'Result', url: 'https://example.com/a', snippet: 'Snippet' }
    ])
  })

  it('records the attempt even when the search comes back empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ results: [] })
    })

    const ctx = createMockContext('/tmp/workspace')
    const registry = new WebSourceRegistry()
    ctx.webSources = registry
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
    await tool.handler({ query: 'nothing matches this' })

    // Exactly the state the unsourced notice keys off: looked, found nothing.
    expect(registry.attempted).toBe(true)
    expect(registry.list()).toHaveLength(0)
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
