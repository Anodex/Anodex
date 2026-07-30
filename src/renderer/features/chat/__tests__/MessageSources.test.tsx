import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WebSource } from '@shared/webSources.types'
import { citedSourceMap } from '../citedSources'
import { MessageContent } from '../MessageContent'
import { MessageSources } from '../MessageSources'

const fetched: WebSource = {
  id: 'S1',
  title: 'Reuters report',
  url: 'https://www.reuters.com/world/story',
  verified: true
}

const searchLead: WebSource = {
  id: 'S2',
  title: 'AP coverage',
  url: 'https://apnews.com/article/abc',
  snippet: 'A snippet only.',
  verified: false
}

describe('citedSourceMap', () => {
  it('numbers sources by the order their ids were minted', () => {
    const map = citedSourceMap([fetched, searchLead])
    expect(map.get('S1')?.number).toBe(1)
    expect(map.get('S2')?.number).toBe(2)
  })

  it('is empty when a turn retrieved nothing', () => {
    expect(citedSourceMap(undefined).size).toBe(0)
  })
})

describe('MessageContent citations', () => {
  it('renders a marker as a link to the source it names', () => {
    const html = renderToStaticMarkup(
      <MessageContent content="Missiles were fired [S1]." sources={[fetched]} />
    )
    expect(html).toContain('href="https://www.reuters.com/world/story"')
    expect(html).toContain('>1</a>')
    // The raw marker must not survive next to the chip that replaced it.
    expect(html).not.toContain('[S1]')
  })

  it('leaves an invented marker as visible text rather than dressing it up', () => {
    // The failure this whole feature exists to catch: a model citing a source
    // that was never retrieved. Rendering [S7] as a link would launder it.
    const html = renderToStaticMarkup(
      <MessageContent content="China shipped weapons [S7]." sources={[fetched]} />
    )
    expect(html).toContain('[S7]')
    expect(html).not.toContain('<a')
  })

  it('renders a marker with no sources at all as plain text', () => {
    const html = renderToStaticMarkup(<MessageContent content="A claim [S1]." />)
    expect(html).toContain('[S1]')
    expect(html).not.toContain('<a')
  })

  it('distinguishes an unfetched search lead from a fetched page', () => {
    const verifiedHtml = renderToStaticMarkup(
      <MessageContent content="Claim [S1]." sources={[fetched, searchLead]} />
    )
    const leadHtml = renderToStaticMarkup(
      <MessageContent content="Claim [S2]." sources={[fetched, searchLead]} />
    )
    expect(leadHtml).toContain('page not fetched')
    expect(verifiedHtml).not.toContain('page not fetched')
  })

  it('still renders code and bold alongside citations', () => {
    const html = renderToStaticMarkup(
      <MessageContent content="**Bold** and `code` and [S1]." sources={[fetched]} />
    )
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('code')
    expect(html).toContain('>1</a>')
  })

  it('does not treat a bracketed non-citation as a marker', () => {
    const html = renderToStaticMarkup(
      <MessageContent content="See [Section] and [S0] and [Sx]." sources={[fetched]} />
    )
    expect(html).toContain('[Section]')
    expect(html).toContain('[S0]')
    expect(html).toContain('[Sx]')
    expect(html).not.toContain('<a')
  })
})

describe('MessageSources', () => {
  it('says plainly when web tools ran and retrieved nothing', () => {
    const html = renderToStaticMarkup(<MessageSources sources={[]} attempted streaming={false} />)
    expect(html).toContain('No sources were retrieved')
    expect(html).toContain('training data')
  })

  it('stays silent when no web tool ever ran', () => {
    // A local coding answer has no business carrying a sourcing disclaimer.
    expect(
      renderToStaticMarkup(<MessageSources sources={[]} attempted={false} streaming={false} />)
    ).toBe('')
  })

  it('claims nothing while tokens are still arriving', () => {
    expect(renderToStaticMarkup(<MessageSources sources={[]} attempted streaming />)).toBe('')
  })

  it('shows a bare host as the label while linking the real URL', () => {
    const html = renderToStaticMarkup(
      <MessageSources sources={[fetched, searchLead]} attempted streaming={false} />
    )
    // The visible label drops www; the href must not, or the link breaks.
    expect(html).toMatch(/>reuters\.com</)
    expect(html).not.toMatch(/>www\.reuters\.com</)
    expect(html).toContain('href="https://www.reuters.com/world/story"')
    expect(html).toMatch(/>apnews\.com</)
  })

  it('reports how many of the sources were actually fetched', () => {
    const mixed = renderToStaticMarkup(
      <MessageSources sources={[fetched, searchLead]} attempted streaming={false} />
    )
    expect(mixed).toContain('1 of 2 fetched')

    const allFetched = renderToStaticMarkup(
      <MessageSources sources={[fetched]} attempted streaming={false} />
    )
    expect(allFetched).toContain('1 source')
    expect(allFetched).not.toContain('of 1 fetched')
  })

  it('marks an unfetched lead as such in the list', () => {
    const html = renderToStaticMarkup(
      <MessageSources sources={[searchLead]} attempted streaming={false} />
    )
    expect(html).toContain('lead')
  })
})
