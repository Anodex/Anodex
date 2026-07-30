import { describe, expect, it } from 'vitest'
import { WebSourceRegistry } from '../WebSourceRegistry'

const lead = (url: string, title = 'Title'): Parameters<WebSourceRegistry['register']>[0] => ({
  title,
  url,
  verified: false
})

describe('WebSourceRegistry', () => {
  it('mints sequential ids in the order sources are first seen', () => {
    const registry = new WebSourceRegistry()
    expect(registry.register(lead('https://a.example/one'))).toBe('S1')
    expect(registry.register(lead('https://b.example/two'))).toBe('S2')
    expect(registry.list().map((source) => source.id)).toEqual(['S1', 'S2'])
  })

  it('returns the original id for the same page rather than a second entry', () => {
    const registry = new WebSourceRegistry()
    registry.register(lead('https://a.example/post'))
    // Trailing slash, fragment, and a re-search of the same result.
    expect(registry.register(lead('https://a.example/post/'))).toBe('S1')
    expect(registry.register(lead('https://a.example/post#section'))).toBe('S1')
    expect(registry.list()).toHaveLength(1)
  })

  it('upgrades a search lead in place once the page is fetched', () => {
    const registry = new WebSourceRegistry()
    registry.register({ title: 'Provider rewrite', url: 'https://a.example/x', verified: false })
    expect(registry.hasVerified()).toBe(false)

    expect(
      registry.register({ title: 'Real page title', url: 'https://a.example/x', verified: true })
    ).toBe('S1')

    const [source] = registry.list()
    expect(source.verified).toBe(true)
    // A fetched page's own <title> is better than the search provider's rewrite.
    expect(source.title).toBe('Real page title')
    expect(registry.hasVerified()).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })

  it('never lets a fetch downgrade an already-verified source', () => {
    const registry = new WebSourceRegistry()
    registry.register({ title: 'Page', url: 'https://a.example/x', verified: true })
    registry.register({ title: 'Page', url: 'https://a.example/x', verified: false })
    expect(registry.list()[0].verified).toBe(true)
  })

  it('keeps the first snippet it was given and fills an empty one later', () => {
    const registry = new WebSourceRegistry()
    registry.register({ title: 'T', url: 'https://a.example/x', verified: false })
    registry.register({
      title: 'T',
      url: 'https://a.example/x',
      snippet: 'arrived later',
      verified: false
    })
    expect(registry.list()[0].snippet).toBe('arrived later')
  })

  it('rejects anything that is not a fetchable http(s) page', () => {
    const registry = new WebSourceRegistry()
    expect(registry.register(lead('file:///etc/passwd'))).toBeNull()
    expect(registry.register(lead('javascript:alert(1)'))).toBeNull()
    expect(registry.register(lead('not a url'))).toBeNull()
    expect(registry.list()).toHaveLength(0)
  })

  it('trims trailing sentence punctuation off a URL the model echoed back', () => {
    const registry = new WebSourceRegistry()
    registry.register(lead('https://a.example/page.'))
    expect(registry.list()[0].url).toBe('https://a.example/page')
  })

  it('falls back to the hostname when a source has no usable title', () => {
    const registry = new WebSourceRegistry()
    registry.register({ title: '   ', url: 'https://news.example/story', verified: true })
    expect(registry.list()[0].title).toBe('news.example')
  })

  it('separates having looked from having found', () => {
    const registry = new WebSourceRegistry()
    expect(registry.attempted).toBe(false)

    registry.recordAttempt()

    // The case the unsourced notice exists for: a search ran and returned nothing.
    expect(registry.attempted).toBe(true)
    expect(registry.list()).toHaveLength(0)
    expect(registry.hasVerified()).toBe(false)
  })

  it('stops minting ids past the per-turn ceiling', () => {
    const registry = new WebSourceRegistry()
    for (let i = 0; i < 60; i++) registry.register(lead(`https://a.example/${i}`))
    expect(registry.list()).toHaveLength(60)
    expect(registry.register(lead('https://a.example/overflow'))).toBeNull()
    expect(registry.list()).toHaveLength(60)
  })

  it('hands out copies, so a caller cannot mutate registry state', () => {
    const registry = new WebSourceRegistry()
    registry.register(lead('https://a.example/x'))
    registry.list()[0].verified = true
    expect(registry.list()[0].verified).toBe(false)
  })
})
