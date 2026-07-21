import { describe, expect, it } from 'vitest'
import type { CriticalThinkingCoverageAssessment } from '@shared/criticalThinking.types'
import {
  assessmentIsSufficient,
  mapWithConcurrency,
  selectResearchCandidates
} from '../criticalThinkingResearchPolicy'

describe('Critical Thinking research policy', () => {
  it('selects canonical, relevant, domain-diverse search results', () => {
    const candidates = selectResearchCandidates(
      [
        {
          query: 'battery safety report',
          results: [
            {
              title: 'Battery safety report',
              url: 'https://www.alpha.example/report',
              snippet: 'Primary battery findings'
            },
            {
              title: 'Another battery article',
              url: 'https://alpha.example/other',
              snippet: 'Secondary discussion'
            },
            {
              title: 'Independent report',
              url: 'https://beta.example/study',
              snippet: 'Battery safety evidence'
            },
            {
              title: 'Already fetched',
              url: 'https://gamma.example/known#results',
              snippet: 'Known evidence'
            },
            {
              title: 'Unsupported scheme',
              url: 'ftp://files.example/report',
              snippet: 'Not a webpage'
            },
            {
              title: 'Credential-bearing URL',
              url: 'https://user:secret@private.example/report',
              snippet: 'Must not be selected'
            }
          ]
        }
      ],
      new Set(['https://gamma.example/known']),
      3
    )

    expect(candidates.map((candidate) => candidate.url)).toEqual([
      'https://www.alpha.example/report',
      'https://beta.example/study',
      'https://alpha.example/other'
    ])
    expect(selectResearchCandidates([], new Set(), 0)).toEqual([])
  })

  it('excludes login-walled social/UGC hosts, including subdomains, from research candidates', () => {
    // The exact live failure: search returned Facebook/Instagram links whose
    // login-wall stub then verified as junk evidence and crowded out real
    // academic sources. They must never be selected for fetching.
    const candidates = selectResearchCandidates(
      [
        {
          query: 'honey bee venom composition',
          results: [
            {
              title: 'The Educated Monkey post',
              url: 'https://www.facebook.com/theeducatedmonkey/posts/123',
              snippet: 'A bee, a wasp, and a fire ant...'
            },
            {
              title: 'Instagram reel',
              url: 'https://www.instagram.com/p/abc',
              snippet: 'Sting comparison'
            },
            {
              title: 'Mobile Facebook',
              url: 'https://m.facebook.com/story/456',
              snippet: 'Bee sting'
            },
            {
              title: 'Bee Venom and Its Sub-Components (PMC)',
              url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7998195/',
              snippet: 'Venom proteome and peptide composition'
            },
            {
              title: 'Schmidt sting pain index',
              url: 'https://en.wikipedia.org/wiki/Schmidt_sting_pain_index',
              snippet: 'Pain ratings by species'
            }
          ]
        }
      ],
      new Set(),
      5
    )

    const urls = candidates.map((candidate) => candidate.url)
    expect(urls).toEqual([
      'https://pmc.ncbi.nlm.nih.gov/articles/PMC7998195/',
      'https://en.wikipedia.org/wiki/Schmidt_sting_pain_index'
    ])
    expect(urls.some((url) => /facebook\.com|instagram\.com/.test(url))).toBe(false)
  })

  it('requires a service-verified evidence floor for model-proposed sufficiency', () => {
    const multiple: CriticalThinkingCoverageAssessment = {
      verdict: 'sufficient',
      evidenceBasis: 'multiple-sources',
      rationale: 'Two independent pages agree.',
      remainingGaps: [],
      nextQueries: []
    }
    const primary: CriticalThinkingCoverageAssessment = {
      ...multiple,
      evidenceBasis: 'authoritative-primary'
    }

    expect(assessmentIsSufficient(multiple, 1)).toBe(false)
    expect(assessmentIsSufficient(multiple, 2)).toBe(true)
    expect(assessmentIsSufficient(primary, 1)).toBe(true)
    expect(
      assessmentIsSufficient({ ...multiple, remainingGaps: ['Resolve a contradiction.'] }, 3)
    ).toBe(false)
  })

  it('keeps the most relevant representation when providers repeat a URL', () => {
    const [candidate] = selectResearchCandidates(
      [
        {
          query: 'official battery safety data',
          results: [
            {
              title: 'Generic landing page',
              url: 'https://example.com/report#top',
              snippet: 'Welcome'
            }
          ]
        },
        {
          query: 'battery incident report',
          results: [
            {
              title: 'Official battery incident safety report',
              url: 'https://example.com/report',
              snippet: 'Primary safety data'
            }
          ]
        }
      ],
      new Set(),
      1
    )

    expect(candidate.title).toBe('Official battery incident safety report')
    expect(candidate.query).toBe('battery incident report')
  })

  it('bounds concurrency, preserves order, and contains individual failures', async () => {
    let active = 0
    let maximumActive = 0
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => setTimeout(resolve, 2))
      active--
      if (value === 3) throw new Error('expected failure')
      return value * 10
    })

    expect(maximumActive).toBe(2)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 })
    expect(results[1]).toEqual({ status: 'fulfilled', value: 20 })
    expect(results[2]?.status).toBe('rejected')
    expect(results[2]?.status === 'rejected' && results[2].reason instanceof Error).toBe(true)
    expect(results[3]).toEqual({ status: 'fulfilled', value: 40 })
  })

  it('returns dense cancellation results for work that never started', async () => {
    const controller = new AbortController()
    const results = await mapWithConcurrency(
      [1, 2, 3],
      1,
      (value) => {
        controller.abort()
        return Promise.resolve(value)
      },
      controller.signal
    )

    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(results.slice(1)).toSatisfy((entries: PromiseSettledResult<number>[]) =>
      entries.every((entry) => entry.status === 'rejected' && entry.reason instanceof Error)
    )
  })
})
