import { describe, expect, it } from 'vitest'
import type {
  CriticalThinkingActivity,
  CriticalThinkingRoundState,
  CriticalThinkingRun
} from '@shared/criticalThinking.types'
import type { WebFetchArtifactDraft, ToolArtifact } from '@shared/toolArtifacts.types'
import type { RunGenerationResult } from '../../chat/runGeneration'
import {
  CriticalThinkingResearchRunner,
  type CriticalThinkingResearchRunnerDeps,
  type CriticalThinkingRunUsage
} from '../CriticalThinkingResearchRunner'
import { DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY } from '../criticalThinkingResearchPolicy'
import { criticalThinkingSynthesisLimits } from '../criticalThinkingSynthesisBudget'

const EMPTY_STATS = { tokens: 0, durationMs: 0, tokensPerSecond: 0 }

describe('CriticalThinkingResearchRunner', () => {
  it('completes adaptive rounds and advances after an insufficient assessment', async () => {
    const phases: string[] = []
    let assessmentCalls = 0
    const harness = createHarness({
      runModel: (phase) => {
        phases.push(phase)
        if (phase === 'query') return Promise.resolve(generation('{"queries":["first query"]}'))
        assessmentCalls++
        return Promise.resolve(
          assessmentCalls === 1
            ? generation(
                assessmentJson({
                  finding: 'The first round leaves a material gap.',
                  verdict: 'continue',
                  evidenceBasis: 'insufficient',
                  remainingGaps: ['Find an independent source.'],
                  nextQueries: ['second query']
                })
              )
            : generation(
                assessmentJson({
                  finding: 'Independent fetched sources answer the step.',
                  verdict: 'sufficient',
                  evidenceBasis: 'multiple-sources',
                  remainingGaps: [],
                  nextQueries: []
                })
              )
        )
      },
      search: (query) =>
        Promise.resolve({
          provider: 'test',
          results: [
            {
              title: `${query} source A`,
              url: `https://${query === 'first query' ? 'alpha' : 'gamma'}.example/report`,
              snippet: 'Relevant evidence'
            },
            {
              title: `${query} source B`,
              url: `https://${query === 'first query' ? 'beta' : 'delta'}.example/report`,
              snippet: 'Independent evidence'
            }
          ]
        })
    })
    const usage = emptyUsage()

    const result = await harness.runner.run(new AbortController().signal, usage)

    expect(result).toEqual({ status: 'completed', stopped: false, runBudgetReached: false })
    expect(phases).toEqual(['query', 'assessment', 'assessment'])
    expect(harness.run.steps[0].rounds).toHaveLength(2)
    expect(harness.run.steps[0].rounds.map((round) => round.status)).toEqual([
      'completed',
      'completed'
    ])
    expect(harness.run.steps[0].rounds[0].assessment?.verdict).toBe('continue')
    expect(harness.run.steps[0].status).toBe('completed')
    expect(harness.run.steps[0].finding).toBe('Independent fetched sources answer the step.')
    expect(usage).toEqual({ rounds: 2, searches: 2, fetches: 4 })
  })

  it('yields after maxNewRoundsThisCall without marking the step limited, then resumes and completes', async () => {
    let assessmentCalls = 0
    const harness = createHarness({
      runModel: (phase) => {
        if (phase === 'query') return Promise.resolve(generation('{"queries":["first query"]}'))
        assessmentCalls++
        return Promise.resolve(
          generation(
            assessmentJson({
              finding:
                assessmentCalls === 1 ? 'First round leaves a gap.' : 'Second round is conclusive.',
              verdict: assessmentCalls === 1 ? 'continue' : 'sufficient',
              evidenceBasis: assessmentCalls === 1 ? 'insufficient' : 'multiple-sources',
              remainingGaps: assessmentCalls === 1 ? ['Find an independent source.'] : [],
              nextQueries: assessmentCalls === 1 ? ['second query'] : []
            })
          )
        )
      },
      search: (query) =>
        Promise.resolve({
          provider: 'test',
          results: [
            {
              title: 'A',
              url: `https://${query === 'first query' ? 'alpha' : 'gamma'}.example/report`,
              snippet: 'Evidence'
            },
            {
              title: 'B',
              url: `https://${query === 'first query' ? 'beta' : 'delta'}.example/report`,
              snippet: 'Independent evidence'
            }
          ]
        })
    })
    const usage = emptyUsage()

    const yielded = await harness.runner.run(new AbortController().signal, usage, 1)

    expect(yielded).toEqual({
      status: 'researching',
      stopped: false,
      runBudgetReached: false,
      waveYielded: true
    })
    expect(harness.run.steps[0].status).toBe('researching')
    expect(harness.run.steps[0].rounds).toHaveLength(1)
    expect(harness.run.steps[0].rounds[0].status).toBe('completed')
    expect(usage).toEqual({ rounds: 1, searches: 1, fetches: 2 })

    const completed = await harness.runner.run(new AbortController().signal, usage, 1)

    expect(completed.status).toBe('completed')
    expect(harness.run.steps[0].rounds).toHaveLength(2)
    expect(usage).toEqual({ rounds: 2, searches: 2, fetches: 4 })
  })

  it('enforces the lifetime round cap across repeated wave-capped calls, not just within one call', async () => {
    const run = makeRun()
    run.researchPolicy = { ...run.researchPolicy, maxRoundsPerStep: 2 }
    let queryCalls = 0
    const harness = createHarness({
      run,
      runModel: (phase) => {
        if (phase === 'query') {
          queryCalls++
          return Promise.resolve(generation(`{"queries":["query ${queryCalls}"]}`))
        }
        return Promise.resolve(
          generation(
            assessmentJson({
              finding: 'Still insufficient.',
              verdict: 'continue',
              evidenceBasis: 'insufficient',
              remainingGaps: ['Keep looking.'],
              nextQueries: [`query ${queryCalls + 1}`]
            })
          )
        )
      },
      search: (query) =>
        Promise.resolve({
          provider: 'test',
          results: [
            {
              title: 'A',
              url: `https://${query.replace(/\s+/g, '-')}.example/report`,
              snippet: 'Evidence'
            }
          ]
        })
    })
    const usage = emptyUsage()

    const first = await harness.runner.run(new AbortController().signal, usage, 1)
    expect(first.waveYielded).toBe(true)
    expect(harness.run.steps[0].rounds).toHaveLength(1)

    const second = await harness.runner.run(new AbortController().signal, usage, 1)
    expect(second).toEqual({ status: 'limited', stopped: false, runBudgetReached: false })
    expect(harness.run.steps[0].status).toBe('limited')
    expect(harness.run.steps[0].terminationReason).toBe('rounds-exhausted')
    // The lifetime cap (2) must stop it here — a third wave call must not start a third round.
    expect(harness.run.steps[0].rounds).toHaveLength(2)
  })

  it('fills a repeated proposed query with the uncovered gap and completes strong coverage with caveats', async () => {
    let queryCalls = 0
    let assessmentCalls = 0
    let resultIndex = 0
    const searched: string[] = []
    const harness = createHarness({
      runModel: (phase) => {
        if (phase === 'query') {
          queryCalls++
          return Promise.resolve(generation('{"queries":["bee defensive behavior"]}'))
        }
        assessmentCalls++
        const firstRound = assessmentCalls === 1
        return Promise.resolve(
          generation(
            assessmentJson({
              finding:
                'Multiple scholarly sources describe defensive sting behavior across the compared insects, with enough convergent detail to support a useful bounded comparison while retaining explicit species-specific limitations.',
              verdict: 'continue',
              evidenceBasis: 'multiple-sources',
              remainingGaps: firstRound
                ? ['Bumblebee defensive behavior was not retrieved.']
                : ['A dedicated bumblebee field cohort was not retrieved.'],
              nextQueries: firstRound
                ? ['bee defensive behavior', 'wasp defensive behavior', 'hornet defensive behavior']
                : ['bumblebee defensive behavior field cohort']
            })
          )
        )
      },
      search: (query) => {
        searched.push(query)
        return Promise.resolve({
          provider: 'test',
          results: Array.from({ length: 2 }, () => {
            resultIndex++
            return {
              title: `Scholarly result ${resultIndex}`,
              url: `https://pubmed.ncbi.nlm.nih.gov/${100000 + resultIndex}/`,
              snippet: 'Peer-reviewed evidence'
            }
          })
        })
      }
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('completed')
    expect(queryCalls).toBe(1)
    expect(searched.some((query) => /bumblebee/i.test(query))).toBe(true)
    expect(harness.run.steps[0].rounds).toHaveLength(2)
    expect(harness.run.steps[0].uncertainties).toEqual([
      'A dedicated bumblebee field cohort was not retrieved.'
    ])
    expect(harness.run.sources.filter((source) => source.verified)).toHaveLength(4)
  })

  it('preserves an interrupted phase and resumes without repeating completed work', async () => {
    const round = makeRound({
      status: 'searching',
      queries: ['resume query']
    })
    const run = makeRun([round])
    const controller = new AbortController()
    let abortFirstSearch = true
    let searchCalls = 0
    let fetchCalls = 0
    const harness = createHarness({
      run,
      runModel: (phase) => {
        expect(phase).toBe('assessment')
        return Promise.resolve(
          generation(
            assessmentJson({
              finding: 'The primary source answers the narrow step.',
              verdict: 'sufficient',
              evidenceBasis: 'authoritative-primary',
              remainingGaps: [],
              nextQueries: []
            })
          )
        )
      },
      search: () => {
        searchCalls++
        if (abortFirstSearch) {
          abortFirstSearch = false
          controller.abort()
          return Promise.reject(new Error('cancelled'))
        }
        return Promise.resolve({
          provider: 'test',
          results: [
            {
              title: 'Primary source',
              url: 'https://primary.example/report',
              snippet: 'Definitive evidence'
            }
          ]
        })
      },
      fetch: (url) => {
        fetchCalls++
        return Promise.resolve(fetchDraft(url))
      }
    })
    const usage = emptyUsage()

    const stopped = await harness.runner.run(controller.signal, usage)

    expect(stopped).toEqual({ status: 'pending', stopped: true, runBudgetReached: false })
    expect(round.status).toBe('searching')
    expect(round.completedAt).toBeNull()
    expect(round.terminationReason).toBe('user')

    const resumed = await harness.runner.run(new AbortController().signal, usage)

    expect(resumed.status).toBe('completed')
    expect(searchCalls).toBe(2)
    expect(fetchCalls).toBe(1)
    expect(harness.run.steps[0].rounds).toHaveLength(1)
    expect(round.status).toBe('completed')
    expect(round.terminationReason).toBeUndefined()
  })

  it('charges only search and fetch operations that actually start before cancellation', async () => {
    const searchRound = makeRound({
      status: 'searching',
      queries: ['first search', 'unstarted search']
    })
    const searchRun = makeRun([searchRound])
    searchRun.researchPolicy.searchConcurrency = 1
    const searchController = new AbortController()
    let searchCalls = 0
    const searchHarness = createHarness({
      run: searchRun,
      search: () => {
        searchCalls++
        searchController.abort('user')
        return Promise.reject(new Error('cancelled'))
      }
    })
    const searchUsage = emptyUsage()

    await searchHarness.runner.run(searchController.signal, searchUsage)

    expect(searchCalls).toBe(1)
    expect(searchUsage.searches).toBe(1)

    const readingRound = makeRound({
      status: 'reading',
      queries: ['completed search'],
      selectedUrls: ['https://one.example/report', 'https://unstarted.example/report']
    })
    const readingRun = makeRun([readingRound])
    readingRun.researchPolicy.fetchConcurrency = 1
    const fetchController = new AbortController()
    let fetchCalls = 0
    const fetchHarness = createHarness({
      run: readingRun,
      fetch: () => {
        fetchCalls++
        fetchController.abort('user')
        return Promise.reject(new Error('cancelled'))
      }
    })
    const fetchUsage = emptyUsage()

    await fetchHarness.runner.run(fetchController.signal, fetchUsage)

    expect(fetchCalls).toBe(1)
    expect(fetchUsage.fetches).toBe(1)
  })

  it('limits the step when every web search fails, instead of throwing and killing the run', async () => {
    // A total search failure used to throw out of the uncaught run() loop and
    // unwind the whole investigation into a reportless failure. It must now
    // limit only this step so other steps and synthesis can still proceed; the
    // specific provider error is preserved in the per-query activity log.
    const round = makeRound({ status: 'searching', queries: ['provider failure'] })
    const harness = createHarness({
      run: makeRun([round]),
      search: () => Promise.reject(new Error('provider unavailable'))
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('limited')
    expect(result.stopped).toBe(false)
    expect(harness.run.steps[0].status).toBe('limited')
    expect(harness.run.steps[0].terminationReason).toBe('no-progress')
    expect(
      harness.activities.some(
        (activity) => activity.status === 'error' && activity.detail === 'provider unavailable'
      )
    ).toBe(true)
  })

  it('limits the step when every selected page fails to load, instead of throwing', async () => {
    const round = makeRound({
      status: 'reading',
      queries: ['completed search'],
      selectedUrls: ['https://unavailable.example/report']
    })
    const harness = createHarness({
      run: makeRun([round]),
      fetch: () => Promise.reject(new Error('connection refused'))
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('limited')
    expect(harness.run.steps[0].status).toBe('limited')
    expect(harness.run.steps[0].terminationReason).toBe('no-progress')
    expect(
      harness.activities.some(
        (activity) => activity.status === 'error' && activity.detail === 'connection refused'
      )
    ).toBe(true)
  })

  it('uses later selected pages when an unreadable page leaves lifetime capacity unused', async () => {
    const firstUrl = 'https://documents.example/unreadable'
    const secondUrl = 'https://primary.example/report'
    const round = makeRound({
      status: 'reading',
      queries: ['completed search'],
      selectedUrls: [firstUrl, secondUrl]
    })
    const run = makeRun([round])
    run.researchPolicy.maxVerifiedSourcesPerRun = 1
    const fetched: string[] = []
    const harness = createHarness({
      run,
      runModel: () =>
        Promise.resolve(
          generation(
            assessmentJson({
              finding: 'The readable primary page answers the step.',
              verdict: 'sufficient',
              evidenceBasis: 'authoritative-primary',
              remainingGaps: [],
              nextQueries: []
            })
          )
        ),
      fetch: (url) => {
        fetched.push(url)
        return Promise.resolve(
          url === firstUrl
            ? {
                ...fetchDraft(url),
                contentType: 'application/pdf',
                passages: [],
                warnings: ['Unsupported content type: application/pdf']
              }
            : fetchDraft(url)
        )
      }
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('completed')
    expect(fetched).toEqual([firstUrl, secondUrl])
    expect(run.sources.filter((source) => source.verified)).toHaveLength(1)
  })

  it('checkpoints a partially searched round at the run budget and resumes its remaining query', async () => {
    const round = makeRound({ status: 'searching', queries: ['query one', 'query two'] })
    const run = makeRun([round])
    run.researchPolicy = { ...run.researchPolicy, maxSearchesPerRun: 1 }
    const searched: string[] = []
    const harness = createHarness({
      run,
      runModel: () =>
        Promise.resolve(
          generation(
            assessmentJson({
              finding: 'Two fetched pages answer the step.',
              verdict: 'sufficient',
              evidenceBasis: 'multiple-sources',
              remainingGaps: [],
              nextQueries: []
            })
          )
        ),
      search: (query) => {
        searched.push(query)
        return Promise.resolve({
          provider: 'test',
          results: [
            {
              title: query,
              url: `https://${query === 'query one' ? 'one' : 'two'}.example/report`,
              snippet: 'Evidence'
            }
          ]
        })
      }
    })

    const limited = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(limited).toEqual({ status: 'limited', stopped: false, runBudgetReached: true })
    expect(round.status).toBe('searching')
    expect(round.terminationReason).toBe('tool-limit')
    expect(searched).toEqual(['query one'])

    const resumed = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(resumed.status).toBe('completed')
    expect(searched).toEqual(['query one', 'query two'])
    expect(round.status).toBe('completed')
  })

  it('checkpoints a partially read round at the run budget and resumes its remaining page', async () => {
    const round = makeRound({
      status: 'reading',
      queries: ['completed query'],
      selectedUrls: ['https://one.example/report', 'https://two.example/report']
    })
    const run = makeRun([round])
    run.researchPolicy = { ...run.researchPolicy, maxFetchesPerRun: 1 }
    const fetched: string[] = []
    const harness = createHarness({
      run,
      runModel: () =>
        Promise.resolve(
          generation(
            assessmentJson({
              finding: 'Both selected pages were fetched.',
              verdict: 'sufficient',
              evidenceBasis: 'multiple-sources',
              remainingGaps: [],
              nextQueries: []
            })
          )
        ),
      fetch: (url) => {
        fetched.push(url)
        return Promise.resolve(fetchDraft(url))
      }
    })

    const limited = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(limited).toEqual({ status: 'limited', stopped: false, runBudgetReached: true })
    expect(round.status).toBe('reading')
    expect(fetched).toEqual(['https://one.example/report'])

    const resumed = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(resumed.status).toBe('completed')
    expect(fetched).toEqual(['https://one.example/report', 'https://two.example/report'])
    expect(round.status).toBe('completed')
  })

  it('reuses a verified page surfaced by a later step without fetching it again', async () => {
    const round = makeRound({ status: 'searching', queries: ['shared source'] })
    let fetchCalls = 0
    const harness = createHarness({
      run: makeRun([round]),
      runModel: () =>
        Promise.resolve(
          generation(
            assessmentJson({
              finding: 'The shared primary page answers this step too.',
              verdict: 'sufficient',
              evidenceBasis: 'authoritative-primary',
              remainingGaps: [],
              nextQueries: []
            })
          )
        ),
      search: () =>
        Promise.resolve({
          provider: 'test',
          results: [
            {
              title: 'Shared primary source',
              url: 'https://shared.example/report#section',
              snippet: 'Relevant to both steps'
            }
          ]
        }),
      fetch: (url) => {
        fetchCalls++
        return Promise.resolve(fetchDraft(url))
      }
    })
    harness.artifacts.push({
      id: 'artifact_shared',
      conversationId: harness.run.id,
      messageId: 'message_previous',
      createdAt: 1,
      research: { stepId: 'step_previous', roundId: 'round_previous' },
      ...fetchDraft('https://shared.example/report')
    })
    harness.run.sources.push({
      id: 'S1',
      title: 'Shared primary source',
      url: 'https://shared.example/report',
      verified: true
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('completed')
    expect(fetchCalls).toBe(0)
    expect(harness.run.steps[0].evidenceIds).toContain('artifact_shared')
    expect(round.evidenceIds).toContain('artifact_shared')
  })

  it.each([
    ['requested URL', 'https://shared.example/start'],
    ['resolved URL', 'https://shared.example/report']
  ])('reuses redirected evidence when search surfaces its %s', async (_label, surfacedUrl) => {
    const round = makeRound({ status: 'searching', queries: ['redirected source'] })
    let fetchCalls = 0
    const harness = createHarness({
      run: makeRun([round]),
      runModel: () =>
        Promise.resolve(
          generation(
            assessmentJson({
              finding: 'The previously fetched redirect target answers this step.',
              verdict: 'sufficient',
              evidenceBasis: 'authoritative-primary',
              remainingGaps: [],
              nextQueries: []
            })
          )
        ),
      search: () =>
        Promise.resolve({
          provider: 'test',
          results: [
            {
              title: 'Redirected primary source',
              url: surfacedUrl,
              snippet: 'Previously fetched evidence'
            }
          ]
        }),
      fetch: (url) => {
        fetchCalls++
        return Promise.resolve(fetchDraft(url))
      }
    })
    harness.artifacts.push({
      id: 'artifact_redirected',
      conversationId: harness.run.id,
      messageId: 'message_previous',
      createdAt: 1,
      research: { stepId: 'step_previous', roundId: 'round_previous' },
      ...redirectFetchDraft('https://shared.example/start', 'https://shared.example/report')
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('completed')
    expect(fetchCalls).toBe(0)
    expect(harness.run.steps[0].evidenceIds).toContain('artifact_redirected')
    expect(round.evidenceIds).toContain('artifact_redirected')
  })

  it('resumes a reading round without refetching the requested side of a completed redirect', async () => {
    const round = makeRound({
      status: 'reading',
      queries: ['redirected source'],
      selectedUrls: ['https://shared.example/start'],
      evidenceIds: ['artifact_redirected']
    })
    const run = makeRun([round])
    run.steps[0].evidenceIds = ['artifact_redirected']
    let fetchCalls = 0
    const harness = createHarness({
      run,
      runModel: () =>
        Promise.resolve(
          generation(
            assessmentJson({
              finding: 'The completed redirect remains available after resume.',
              verdict: 'sufficient',
              evidenceBasis: 'authoritative-primary',
              remainingGaps: [],
              nextQueries: []
            })
          )
        ),
      fetch: (url) => {
        fetchCalls++
        return Promise.resolve(fetchDraft(url))
      }
    })
    harness.artifacts.push({
      id: 'artifact_redirected',
      conversationId: harness.run.id,
      messageId: 'message_current_round',
      createdAt: 1,
      research: { stepId: run.steps[0].id, roundId: round.id },
      ...redirectFetchDraft('https://shared.example/start', 'https://shared.example/report')
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('completed')
    expect(fetchCalls).toBe(0)
    expect(round.status).toBe('completed')
  })

  it('does not refetch a completed page that produced no readable passages', async () => {
    const url = 'https://documents.example/unsupported'
    const round = makeRound({
      status: 'reading',
      queries: ['unsupported document'],
      selectedUrls: [url],
      evidenceIds: ['artifact_unsupported']
    })
    const run = makeRun([round])
    run.researchPolicy.maxRoundsPerStep = 1
    run.steps[0].evidenceIds = ['artifact_unsupported']
    let fetchCalls = 0
    const harness = createHarness({
      run,
      runModel: () =>
        Promise.resolve(
          generation(
            assessmentJson({
              finding: '',
              verdict: 'continue',
              evidenceBasis: 'insufficient',
              remainingGaps: ['A readable source is still required.'],
              nextQueries: []
            })
          )
        ),
      fetch: (requestedUrl) => {
        fetchCalls++
        return Promise.resolve(fetchDraft(requestedUrl))
      }
    })
    harness.artifacts.push({
      id: 'artifact_unsupported',
      conversationId: harness.run.id,
      messageId: 'message_unsupported',
      createdAt: 1,
      research: { stepId: run.steps[0].id, roundId: round.id },
      ...fetchDraft(url),
      contentType: 'application/pdf',
      contentChars: 0,
      passages: [],
      warnings: ['Unsupported content type: application/pdf']
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('limited')
    expect(fetchCalls).toBe(0)
  })

  it('recovers a sufficient persisted assessment before starting another round', async () => {
    const round = makeRound({
      status: 'completed',
      finding: 'The saved authoritative source answers the step.',
      assessment: {
        verdict: 'sufficient',
        evidenceBasis: 'authoritative-primary',
        rationale: 'The primary source directly resolves the narrow question.',
        remainingGaps: [],
        nextQueries: []
      },
      evidenceIds: ['artifact_sufficient'],
      completedAt: 2
    })
    const run = makeRun([round])
    run.steps[0].evidenceIds = ['artifact_sufficient']
    let modelCalls = 0
    const harness = createHarness({
      run,
      runModel: () => {
        modelCalls++
        return Promise.resolve(generation('{}'))
      }
    })
    harness.artifacts.push({
      id: 'artifact_sufficient',
      conversationId: run.id,
      messageId: 'message_sufficient',
      createdAt: 1,
      research: { stepId: run.steps[0].id, roundId: round.id },
      ...fetchDraft('https://primary.example/report')
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('completed')
    expect(run.steps[0].status).toBe('completed')
    expect(run.steps[0].rounds).toHaveLength(1)
    expect(modelCalls).toBe(0)
  })

  it('checks exhausted attempt budgets before starting another model phase', async () => {
    let modelCalls = 0
    const harness = createHarness({
      runModel: () => {
        modelCalls++
        return Promise.resolve(generation('{"queries":["should not run"]}'))
      }
    })
    const usage = emptyUsage()
    usage.searches = harness.run.researchPolicy.maxSearchesPerRun

    const result = await harness.runner.run(new AbortController().signal, usage)

    expect(result).toEqual({ status: 'limited', stopped: false, runBudgetReached: true })
    expect(harness.run.steps[0].terminationReason).toBe('tool-limit')
    expect(modelCalls).toBe(0)
  })

  it('enforces the pinned lifetime verified-evidence cap before new work', async () => {
    const run = makeRun()
    run.researchPolicy.maxVerifiedSourcesPerRun = 1
    run.steps[0].evidenceIds = ['artifact_cap']
    let modelCalls = 0
    const harness = createHarness({
      run,
      runModel: () => {
        modelCalls++
        return Promise.resolve(generation('{"queries":["should not run"]}'))
      }
    })
    harness.artifacts.push({
      id: 'artifact_cap',
      conversationId: run.id,
      messageId: 'message_cap',
      createdAt: 1,
      research: { stepId: run.steps[0].id, roundId: 'round_cap' },
      ...fetchDraft('https://cap.example/report')
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result).toEqual({ status: 'limited', stopped: false, runBudgetReached: true })
    expect(run.steps[0].terminationReason).toBe('evidence-limit')
    expect(modelCalls).toBe(0)
  })

  it('overrides a model phase user-stop mapping when the linked step timer actually fired', async () => {
    const round = makeRound({ status: 'querying' })
    const harness = createHarness(
      {
        run: makeRun([round]),
        runModel: (_phase, _prompt, _maxTokens, signal) =>
          new Promise((resolve) => {
            const onAbort = (): void =>
              resolve({
                ...generation(''),
                stopped: true,
                stopReason: 'user'
              })
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
          })
      },
      10
    )

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result).toEqual({ status: 'limited', stopped: false, runBudgetReached: false })
    expect(harness.run.steps[0].status).toBe('limited')
    expect(harness.run.steps[0].terminationReason).toBe('time-limit')
    expect(round.status).toBe('querying')
    expect(round.terminationReason).toBe('time-limit')
    expect(round.completedAt).toBeNull()
  })

  it('accepts valid queries produced right before a recoverable token-limit stop', async () => {
    const round = makeRound({ status: 'querying' })
    const harness = createHarness({
      run: makeRun([round]),
      runModel: (phase) => {
        if (phase === 'query') {
          return Promise.resolve(
            generation('{"queries":["bee venom composition"]}', {
              stopped: true,
              stopReason: 'token-limit'
            })
          )
        }
        return Promise.resolve(
          generation(
            assessmentJson({
              finding: 'Independent fetched sources answer the step.',
              verdict: 'sufficient',
              evidenceBasis: 'multiple-sources',
              remainingGaps: [],
              nextQueries: []
            })
          )
        )
      },
      search: () =>
        Promise.resolve({
          provider: 'test',
          results: [
            { title: 'A', url: 'https://alpha.example/report', snippet: 'Evidence' },
            { title: 'B', url: 'https://beta.example/report', snippet: 'Independent evidence' }
          ]
        })
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('completed')
    expect(round.queries).toEqual(['bee venom composition'])
  })

  it('evaluates a valid assessment via the sufficiency floor after a recoverable token-limit stop', async () => {
    const round = makeRound({
      status: 'assessing',
      queries: ['completed query'],
      selectedUrls: ['https://one.example/report', 'https://two.example/report']
    })
    const run = makeRun([round])
    const harness = createHarness({
      run,
      runModel: () =>
        Promise.resolve(
          generation(
            assessmentJson({
              finding: 'Two independent fetched pages answer the step.',
              verdict: 'sufficient',
              evidenceBasis: 'multiple-sources',
              remainingGaps: [],
              nextQueries: []
            }),
            { stopped: true, stopReason: 'token-limit' }
          )
        ),
      fetch: (url) => Promise.resolve(fetchDraft(url))
    })
    // The round is already past querying/searching/reading in this fixture,
    // but the runner still re-derives fetched state from artifacts — seed
    // both selected URLs as already-fetched so assessment is reached directly.
    harness.artifacts.push(
      {
        id: 'artifact_one',
        conversationId: run.id,
        messageId: 'message_one',
        createdAt: 1,
        research: { stepId: run.steps[0].id, roundId: round.id },
        ...fetchDraft('https://one.example/report')
      },
      {
        id: 'artifact_two',
        conversationId: run.id,
        messageId: 'message_two',
        createdAt: 1,
        research: { stepId: run.steps[0].id, roundId: round.id },
        ...fetchDraft('https://two.example/report')
      }
    )
    run.steps[0].evidenceIds = ['artifact_one', 'artifact_two']
    round.evidenceIds = ['artifact_one', 'artifact_two']

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('completed')
    expect(round.status).toBe('completed')
    expect(round.assessment?.verdict).toBe('sufficient')
    expect(round.finding).toBe('Two independent fetched pages answer the step.')
  })

  it('carries the no-progress guard across a resumed execution', async () => {
    const previous = makeRound({
      status: 'completed',
      assessment: {
        verdict: 'continue',
        evidenceBasis: 'insufficient',
        rationale: 'No useful page was fetched.',
        remainingGaps: ['Find evidence.'],
        nextQueries: []
      },
      completedAt: 2
    })
    const harness = createHarness({
      run: makeRun([previous]),
      runModel: (phase) =>
        Promise.resolve(
          phase === 'query'
            ? generation('{"queries":["new query"]}')
            : generation(
                assessmentJson({
                  finding: 'No verified evidence was found.',
                  verdict: 'continue',
                  evidenceBasis: 'insufficient',
                  remainingGaps: ['Find evidence.'],
                  nextQueries: []
                })
              )
        ),
      search: () => Promise.resolve({ provider: 'test', results: [] })
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('limited')
    expect(harness.run.steps[0].terminationReason).toBe('no-progress')
    expect(harness.run.steps[0].rounds).toHaveLength(2)
    expect(harness.run.steps[0].rounds[1].status).toBe('completed')
  })

  it('does not replace a valid cumulative finding with malformed assessment output', async () => {
    const round = makeRound({ status: 'assessing' })
    const run = makeRun([round])
    run.steps[0].finding = 'Previously validated cumulative finding.'
    run.researchPolicy = { ...run.researchPolicy, maxRoundsPerStep: 1 }
    const harness = createHarness({
      run,
      runModel: () =>
        Promise.resolve(
          generation(
            '{"finding":"Malformed replacement","verdict":"continue","rationale":"Missing required arrays"}'
          )
        )
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('limited')
    expect(run.steps[0].finding).toBe('Previously validated cumulative finding.')
    expect(round.finding).toBe('Previously validated cumulative finding.')
    expect(round.assessment?.verdict).toBe('continue')
  })

  it('keeps a malformed round response as the finding when the step had none yet, instead of discarding it', async () => {
    // Same malformed shape as the previous test (no `evidenceBasis`, so the
    // assessment fails to parse), but the step has no prior finding to
    // protect — there is nothing to "not replace", so the model's actual
    // output for this round should survive instead of the step ending with
    // an empty finding.
    const round = makeRound({ status: 'assessing' })
    const run = makeRun([round])
    run.researchPolicy = { ...run.researchPolicy, maxRoundsPerStep: 1 }
    const harness = createHarness({
      run,
      runModel: () =>
        Promise.resolve(
          generation(
            '{"finding":"The model actually analyzed this round.","verdict":"continue","rationale":"Missing required arrays"}'
          )
        )
    })

    const result = await harness.runner.run(new AbortController().signal, emptyUsage())

    expect(result.status).toBe('limited')
    expect(run.steps[0].finding).toBe('The model actually analyzed this round.')
    expect(round.finding).toBe('The model actually analyzed this round.')
    // The internal parser-failure sentence must never reach the user-facing
    // gap list — it reads as a research finding, not a diagnostic message.
    expect(run.steps[0].uncertainties).not.toContain(
      'A valid evidence coverage assessment is still required.'
    )
    expect(run.steps[0].uncertainties).toEqual([])
  })

  it('keeps a query-generation prompt inside the small local-context budget', async () => {
    const previous = makeRound({
      status: 'completed',
      queries: Array.from({ length: 40 }, (_, index) => `prior query ${index} ${'q'.repeat(300)}`),
      assessment: {
        verdict: 'continue',
        evidenceBasis: 'insufficient',
        rationale: 'More evidence is needed.',
        remainingGaps: Array.from(
          { length: 20 },
          (_, index) => `remaining gap ${index} ${'g'.repeat(300)}`
        ),
        nextQueries: []
      },
      completedAt: 2
    })
    const run = makeRun([previous])
    run.question = 'question '.repeat(3_000)
    for (let index = 0; index < 12; index++) {
      run.steps.push({
        ...run.steps[0],
        id: `prior_step_${index}`,
        title: `Prior step ${index}`,
        finding: `prior finding ${index} ${'f'.repeat(2_000)}`,
        rounds: [],
        evidenceIds: [],
        uncertainties: []
      })
    }
    const capturedPrompts: string[] = []
    const harness = createHarness({
      run,
      contextTokens: 4_096,
      runModel: (_phase, prompt) => {
        capturedPrompts.push(prompt)
        return Promise.resolve({
          ...generation(''),
          stopped: true,
          stopReason: 'yielded'
        })
      }
    })

    await harness.runner.run(new AbortController().signal, emptyUsage())

    const limit = criticalThinkingSynthesisLimits(4_096).maxPromptChars
    expect(capturedPrompts).toHaveLength(1)
    expect(capturedPrompts[0].length).toBeLessThanOrEqual(limit)
    expect(capturedPrompts[0]).toContain('Return strict JSON only')
  })
})

interface HarnessOverrides {
  run?: CriticalThinkingRun
  runModel?: CriticalThinkingResearchRunnerDeps['runModel']
  search?: CriticalThinkingResearchRunnerDeps['search']
  fetch?: CriticalThinkingResearchRunnerDeps['fetch']
  contextTokens?: number
}

function createHarness(
  overrides: HarnessOverrides = {},
  stepTimeoutMs?: number
): {
  run: CriticalThinkingRun
  runner: CriticalThinkingResearchRunner
  artifacts: ToolArtifact[]
  activities: CriticalThinkingActivity[]
} {
  const run = overrides.run ?? makeRun()
  const artifacts: ToolArtifact[] = []
  const activities: CriticalThinkingActivity[] = []
  const deps: CriticalThinkingResearchRunnerDeps = {
    getRun: () => run,
    listArtifacts: () => artifacts,
    runModel:
      overrides.runModel ??
      (() =>
        Promise.resolve(
          generation(
            assessmentJson({
              finding: 'Default finding',
              verdict: 'continue',
              evidenceBasis: 'insufficient',
              remainingGaps: ['More evidence is required.'],
              nextQueries: []
            })
          )
        )),
    search:
      overrides.search ??
      (() =>
        Promise.resolve({
          provider: 'test',
          results: []
        })),
    fetch: overrides.fetch ?? ((url) => Promise.resolve(fetchDraft(url))),
    recordArtifact: (artifact, roundId) => {
      artifacts.push(artifact)
      const step = run.steps[run.currentStep]
      const activeRound = step.rounds.find((candidate) => candidate.id === roundId)
      step.evidenceIds = [...new Set([...step.evidenceIds, artifact.id])]
      if (activeRound) {
        activeRound.evidenceIds = [...new Set([...activeRound.evidenceIds, artifact.id])]
      }
      if (
        artifact.kind === 'web-fetch' &&
        !run.sources.some((source) => source.url === artifact.finalUrl)
      ) {
        run.sources.push({
          id: `S${run.sources.length + 1}`,
          title: artifact.title,
          url: artifact.finalUrl,
          verified: artifact.passages.length > 0
        })
      }
    },
    updateStep: (patch) => Object.assign(run.steps[run.currentStep], patch),
    appendRound: (round) => run.steps[run.currentStep].rounds.push(round),
    updateRound: (roundId, patch) => {
      const round = run.steps[run.currentStep].rounds.find((candidate) => candidate.id === roundId)
      if (!round) throw new Error('Test round not found')
      Object.assign(round, patch)
    },
    recordActivity: (activity) => {
      const index = activities.findIndex((candidate) => candidate.id === activity.id)
      if (index >= 0) activities[index] = activity
      else activities.push(activity)
    },
    addStats: () => undefined,
    checkpoint: () => Promise.resolve(),
    contextTokens: overrides.contextTokens ?? 8_192
  }
  return {
    run,
    artifacts,
    activities,
    runner: new CriticalThinkingResearchRunner(deps, { stepTimeoutMs })
  }
}

function makeRun(rounds: CriticalThinkingRoundState[] = []): CriticalThinkingRun {
  return {
    id: 'critical_test',
    question: 'What does the evidence show?',
    status: 'researching',
    provider: 'local',
    model: null,
    researchPolicy: {
      ...DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY,
      maxPagesPerRound: 2
    },
    plan: {
      title: 'Research plan',
      steps: [{ id: 'plan_step_1', title: 'Investigate the evidence', status: 'in_progress' }],
      updatedAt: 1
    },
    report: '',
    sources: [],
    steps: [
      {
        id: 'step_1',
        title: 'Investigate the evidence',
        status: 'researching',
        attempts: 1,
        evidenceIds: [],
        finding: '',
        uncertainties: [],
        rounds,
        terminationReason: undefined
      }
    ],
    currentStep: 0,
    evidenceCount: 0,
    activities: [],
    stats: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeRound(patch: Partial<CriticalThinkingRoundState>): CriticalThinkingRoundState {
  return {
    id: 'round_existing',
    index: 0,
    status: 'querying',
    queries: [],
    selectedUrls: [],
    evidenceIds: [],
    finding: '',
    assessment: null,
    startedAt: 1,
    completedAt: null,
    ...patch
  }
}

function generation(
  content: string,
  overrides: Partial<RunGenerationResult> = {}
): RunGenerationResult {
  return { content, stats: EMPTY_STATS, stopped: false, ...overrides }
}

function assessmentJson(input: {
  finding: string
  verdict: 'continue' | 'sufficient'
  evidenceBasis: 'multiple-sources' | 'authoritative-primary' | 'insufficient'
  remainingGaps: string[]
  nextQueries: string[]
}): string {
  return JSON.stringify({
    ...input,
    uncertainties: input.remainingGaps,
    rationale: 'Bounded test assessment.'
  })
}

function fetchDraft(url: string): WebFetchArtifactDraft {
  return {
    kind: 'web-fetch',
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: 'text/html',
    title: 'Fetched source',
    contentHash: 'hash',
    contentChars: 100,
    truncated: false,
    passages: [{ id: 'P1', text: 'Verified evidence passage.', score: 1 }],
    warnings: []
  }
}

function redirectFetchDraft(requestedUrl: string, finalUrl: string): WebFetchArtifactDraft {
  return {
    ...fetchDraft(finalUrl),
    requestedUrl,
    finalUrl
  }
}

function emptyUsage(): CriticalThinkingRunUsage {
  return { rounds: 0, searches: 0, fetches: 0 }
}
