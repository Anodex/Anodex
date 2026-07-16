import { describe, expect, it } from 'vitest'
import {
  mergeSources,
  sourcesFromReport,
  sourcesFromSearchResult
} from '../criticalThinkingSources'

describe('Critical Thinking source extraction', () => {
  it('extracts structured sources from web_search output', () => {
    const sources = sourcesFromSearchResult(`1. **Primary report** — https://example.com/report
The original research report.

2. **Independent review** — https://review.example.org/findings
A separate analysis.`)

    expect(sources).toEqual([
      {
        title: 'Primary report',
        url: 'https://example.com/report',
        snippet: 'The original research report.'
      },
      {
        title: 'Independent review',
        url: 'https://review.example.org/findings',
        snippet: 'A separate analysis.'
      }
    ])
  })

  it('extracts only public HTTP links from a final report', () => {
    const sources = sourcesFromReport(
      'See [the evidence](https://example.com/evidence) and [local notes](file:///tmp/notes).'
    )

    expect(sources).toEqual([
      { title: 'the evidence', url: 'https://example.com/evidence', snippet: undefined }
    ])
  })

  it('deduplicates matching source URLs while preserving the first source metadata', () => {
    const sources = mergeSources(
      [{ title: 'Original', url: 'https://example.com/report/' }],
      [{ title: 'Duplicate', url: 'https://example.com/report' }]
    )

    expect(sources).toEqual([{ title: 'Original', url: 'https://example.com/report/' }])
  })
})
