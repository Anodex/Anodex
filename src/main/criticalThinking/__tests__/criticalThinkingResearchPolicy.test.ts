import { describe, expect, it } from 'vitest'
import type { CriticalThinkingCoverageAssessment } from '@shared/criticalThinking.types'
import {
  DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY,
  assessmentIsSufficient,
  mapWithConcurrency,
  researchRunBudgetMs,
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

  it('never selects more pages than the requested limit after domain diversification', () => {
    const candidates = selectResearchCandidates(
      [
        {
          query: 'comparative venom study',
          results: Array.from({ length: 8 }, (_, index) => ({
            title: `Comparative venom study ${index}`,
            url: `https://source-${index}.example/study`,
            snippet: 'Independent comparative venom evidence'
          }))
        }
      ],
      new Set(),
      4
    )

    expect(candidates).toHaveLength(4)
  })

  it('prefers primary and academic sources over equally relevant commercial pages', () => {
    const candidates = selectResearchCandidates(
      [
        {
          query: 'hymenoptera venom clinical study',
          results: [
            {
              title: 'Hymenoptera venom clinical study blog',
              url: 'https://bugs.example/blog',
              snippet: 'Pest control exterminator blog about venom'
            },
            {
              title: 'Hymenoptera venom clinical study',
              url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC123/',
              snippet: 'Peer-reviewed journal study'
            }
          ]
        }
      ],
      new Set(),
      1
    )

    expect(candidates[0]?.url).toContain('pmc.ncbi.nlm.nih.gov')
  })

  it('ranks the term that scopes the query above the generic terms every result shares', () => {
    // The live failure: a Colorado-scoped step filled its evidence with a
    // Chinese excavator manufacturer, a UAE dealer, and Hitachi Construction
    // Machinery *Africa*. Every result matched "construction", "mining",
    // "excavators" and "wheel loaders"; counting each term equally let four
    // generic matches outrank the single term that actually located the
    // question.
    const candidates = selectResearchCandidates(
      [
        {
          query: 'colorado construction mining excavators wheel loaders projects',
          results: [
            {
              title: 'Excavators: Versatile Machinery for Construction & Mining',
              url: 'https://rippa.example/excavators',
              snippet: 'Wheel loaders and excavators for construction and mining projects'
            },
            {
              title: 'Wheel Loaders - Construction Machinery Africa',
              url: 'https://machinery-africa.example/wheel-loaders',
              snippet: 'Excavators and wheel loaders for construction and mining projects'
            },
            {
              title: 'Excavators & Wheel Loaders for Construction Projects UAE',
              url: 'https://gulf-machinery.example/construction',
              snippet: 'Wheel loaders for mining and construction projects'
            },
            {
              title: 'Colorado Mining Activity Dashboard',
              url: 'https://drms.colorado.example/dashboard',
              snippet: 'Active and proposed mining operations across Colorado'
            }
          ]
        }
      ],
      new Set(),
      1
    )

    expect(candidates[0]?.url).toContain('colorado')
  })

  it('excludes login-walled social and media-only hosts, including subdomains, from research candidates', () => {
    // The live failures: search returned Facebook/Instagram login walls and a
    // YouTube page whose only extractable text was footer chrome
    // ("About Press Copyright ... © 2026 Google LLC"). Both verified as junk
    // evidence and crowded out real academic sources — they must never be
    // selected for fetching.
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
              title: 'WASP STING vs BEE STING - YouTube',
              url: 'https://www.youtube.com/watch?v=pEEHf9ciMDA',
              snippet: 'Which hurts worst'
            },
            {
              title: 'Short link',
              url: 'https://youtu.be/pEEHf9ciMDA',
              snippet: 'Video'
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
      6
    )

    const urls = candidates.map((candidate) => candidate.url)
    expect(urls).toEqual([
      'https://pmc.ncbi.nlm.nih.gov/articles/PMC7998195/',
      'https://en.wikipedia.org/wiki/Schmidt_sting_pain_index'
    ])
    expect(
      urls.some((url) => /facebook\.com|instagram\.com|youtube\.com|youtu\.be/.test(url))
    ).toBe(false)
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

describe('Critical Thinking run budget', () => {
  it('gives a local provider more wall-clock than a cloud one', () => {
    // Measured live: a 6-step plan on a local model reached step 2 of 6 in
    // 64.9 minutes against the 60-minute cap. It ran out of clock, not rounds
    // (21 available, an 18-round plan) — local generation is simply slower.
    const local = researchRunBudgetMs('local')
    const cloud = researchRunBudgetMs('openai')
    expect(cloud).toBe(DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxRunMs)
    expect(local).toBeGreaterThan(cloud)
    expect(local).toBeGreaterThan(65 * 60_000)
  })
})
