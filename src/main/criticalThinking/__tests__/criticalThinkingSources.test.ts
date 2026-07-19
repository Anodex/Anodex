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
})
