import { describe, expect, it } from 'vitest'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import {
  mergeSources,
  sourcesFromArtifact,
  sourcesFromSearchResult
} from '../criticalThinkingSources'

describe('Critical Thinking source extraction', () => {
  it('keeps search results as unverified leads', () => {
    const sources = sourcesFromSearchResult(`1. **Primary report** — https://example.com/report
The original research report.`)

    expect(sources).toEqual([
      {
        id: 'S1',
        title: 'Primary report',
        url: 'https://example.com/report',
        snippet: 'The original research report.',
        verified: false
      }
    ])
  })

  it('trusts fetched artifact metadata instead of model-authored report URLs', () => {
    const artifact: ToolArtifact = {
      id: 'artifact_1',
      conversationId: 'critical_test',
      messageId: 'message_1',
      createdAt: 1,
      kind: 'web-fetch',
      requestedUrl: 'https://example.com/start',
      finalUrl: 'https://example.com/report',
      status: 200,
      contentType: 'text/html',
      title: 'Primary report',
      contentHash: 'hash',
      contentChars: 100,
      truncated: false,
      passages: [{ id: 'P1', text: 'Verified passage.', score: 1 }],
      warnings: []
    }

    expect(sourcesFromArtifact(artifact)).toEqual([
      {
        id: 'S1',
        title: 'Primary report',
        url: 'https://example.com/report',
        snippet: undefined,
        verified: true
      }
    ])
  })

  it('upgrades a matching search lead after fetching while preserving its stable id', () => {
    const sources = mergeSources(
      [
        {
          id: 'S1',
          title: 'Search title',
          url: 'https://example.com/report/',
          verified: false
        }
      ],
      [
        {
          id: 'S1',
          title: 'Fetched title',
          url: 'https://example.com/report',
          verified: true
        }
      ]
    )

    expect(sources).toEqual([
      {
        id: 'S1',
        title: 'Fetched title',
        url: 'https://example.com/report',
        verified: true
      }
    ])
  })

  it('preserves case-sensitive URL paths as distinct sources', () => {
    const sources = mergeSources(
      [
        {
          id: 'S1',
          title: 'Uppercase path',
          url: 'https://example.com/Report',
          verified: true
        }
      ],
      [
        {
          id: 'S2',
          title: 'Lowercase path',
          url: 'https://EXAMPLE.com/report',
          verified: true
        }
      ]
    )

    expect(sources).toHaveLength(2)
    expect(sources.map((source) => source.url)).toEqual([
      'https://example.com/Report',
      'https://EXAMPLE.com/report'
    ])
  })

  it('never renumbers existing sources when adding higher-priority evidence', () => {
    const sources = mergeSources(
      [
        {
          id: 'S7',
          title: 'Existing source',
          url: 'https://example.com/existing',
          verified: false
        }
      ],
      [
        {
          id: 'S1',
          title: 'New verified source',
          url: 'https://example.org/new',
          verified: true
        }
      ]
    )

    expect(sources.map((source) => source.id)).toEqual(['S7', 'S8'])
    expect(sources.map((source) => source.title)).toEqual([
      'Existing source',
      'New verified source'
    ])
  })

  it('fills missing and duplicate legacy ids without changing valid unique ids', () => {
    const sources = mergeSources(
      [
        { id: 'S4', title: 'First', url: 'https://one.example', verified: true },
        { id: 'S4', title: 'Second', url: 'https://two.example', verified: true },
        { id: '', title: 'Third', url: 'https://three.example', verified: true }
      ],
      []
    )

    expect(sources.map((source) => source.id)).toEqual(['S4', 'S5', 'S6'])
  })

  it('replaces malformed legacy ids while preserving only positive canonical source ids', () => {
    const sources = mergeSources(
      [
        { id: 'S9', title: 'Valid', url: 'https://valid.example', verified: true },
        { id: 'legacy', title: 'Legacy', url: 'https://legacy.example', verified: true },
        { id: 'S0', title: 'Zero', url: 'https://zero.example', verified: true },
        { id: 'S01', title: 'Padded', url: 'https://padded.example', verified: true }
      ],
      []
    )

    expect(sources.map((source) => source.id)).toEqual(['S9', 'S10', 'S11', 'S12'])
  })

  it('makes room for verified evidence when legacy search leads fill the compact source cap', () => {
    const legacyLeads = Array.from({ length: 100 }, (_, index) => ({
      id: `S${index + 1}`,
      title: `Search lead ${index + 1}`,
      url: `https://lead-${index + 1}.example/report`,
      verified: false
    }))

    const sources = mergeSources(legacyLeads, [
      {
        id: 'S1',
        title: 'New verified evidence',
        url: 'https://verified.example/report',
        verified: true
      }
    ])

    expect(sources).toHaveLength(100)
    expect(sources.filter((source) => source.verified)).toEqual([
      {
        id: 'S101',
        title: 'New verified evidence',
        url: 'https://verified.example/report',
        verified: true
      }
    ])
    expect(sources.some((source) => source.url === 'https://lead-100.example/report')).toBe(false)
  })

  it('keeps the compact source index bounded when verified evidence fills it', () => {
    const verified = Array.from({ length: 100 }, (_, index) => ({
      id: `S${index + 1}`,
      title: `Verified page ${index + 1}`,
      url: `https://verified-${index + 1}.example/report`,
      verified: true
    }))

    const sources = mergeSources(verified, [
      {
        id: '',
        title: 'Additional verified page',
        url: 'https://verified-101.example/report',
        verified: true
      }
    ])

    expect(sources).toHaveLength(100)
    expect(sources.some((source) => source.url === 'https://verified-101.example/report')).toBe(
      false
    )
  })
})

describe('HTML entities in source metadata', () => {
  it('decodes titles and snippets once, where the source is built', () => {
    // A live report cited "Rippa Excavators: Versatile Machinery for
    // Construction &amp; Mining" — the encoded title travelled from the search
    // result into the markdown link of every citation.
    const [source] = sourcesFromArtifact({
      id: 'artifact_1',
      conversationId: 'critical_test',
      messageId: 'message_1',
      createdAt: 1,
      kind: 'web-fetch',
      requestedUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      status: 200,
      contentType: 'text/html',
      title: 'Excavators &amp; Loaders &#8211; Caf&#233; &quot;Test&quot;',
      contentHash: 'hash',
      contentChars: 10,
      truncated: false,
      passages: [{ id: 'P1', text: 'Evidence text', score: 100 }],
      warnings: []
    })

    expect(source.title).toBe('Excavators & Loaders – Café "Test"')
  })

  it('leaves text that merely looks like an entity alone', () => {
    const [source] = sourcesFromArtifact({
      id: 'artifact_2',
      conversationId: 'critical_test',
      messageId: 'message_1',
      createdAt: 1,
      kind: 'web-fetch',
      requestedUrl: 'https://example.com/b',
      finalUrl: 'https://example.com/b',
      status: 200,
      contentType: 'text/html',
      title: 'Profit & loss; margins &notarealentity; up',
      contentHash: 'hash',
      contentChars: 10,
      truncated: false,
      passages: [{ id: 'P1', text: 'Evidence text', score: 100 }],
      warnings: []
    })

    expect(source.title).toBe('Profit & loss; margins &notarealentity; up')
  })
})
