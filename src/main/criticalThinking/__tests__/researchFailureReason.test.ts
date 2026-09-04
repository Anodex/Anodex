import { describe, expect, it } from 'vitest'
import type { CriticalThinkingActivity } from '@shared/criticalThinking.types'
import { GENERIC_RESEARCH_FAILURE, researchFailureReason } from '../researchFailureReason'

/**
 * Why a Critical Thinking run came back with nothing.
 *
 * A run on 2026-09-04 ended `partial`, 0/7 steps, zero sources, reporting
 * "Research finished without a fetched source that could support a validated
 * report." True, and useless: it describes the symptom at the end of the chain.
 *
 * The cause was one line away. All 21 of that run's search activities were
 * recorded `status: 'error'` with the same detail — "SearXNG is not reachable at
 * http://localhost:8080. The instance does not appear to be running — start it,
 * or choose a different search provider in Settings." The search backend was
 * down. The run knew, and said something else.
 *
 * The distinction that matters to whoever reads it: a question research could
 * not answer looks identical to a search provider that is switched off, and only
 * one of those is worth doing anything about.
 */

function search(status: CriticalThinkingActivity['status'], detail?: string) {
  return { id: 'a', kind: 'search', label: 'Search x', status, detail, createdAt: 0 } as const
}

describe('researchFailureReason', () => {
  it('names the cause when every search failed the same way', () => {
    const reason = researchFailureReason([
      search('error', 'SearXNG is not reachable at http://localhost:8080.'),
      search('error', 'SearXNG is not reachable at http://localhost:8080.'),
      search('error', 'SearXNG is not reachable at http://localhost:8080.')
    ])

    expect(reason).toContain('SearXNG is not reachable')
    expect(reason).not.toBe(GENERIC_RESEARCH_FAILURE)
  })

  it('stays generic when some searches worked', () => {
    // Sources were reachable and research still came up empty, which is a
    // finding about the question rather than the setup.
    const reason = researchFailureReason([
      search('success'),
      search('error', 'SearXNG is not reachable at http://localhost:8080.')
    ])

    expect(reason).toBe(GENERIC_RESEARCH_FAILURE)
  })

  it('stays generic when the failures disagree about why', () => {
    // Two different causes is not one cause to report, and picking the first
    // would be inventing a diagnosis.
    const reason = researchFailureReason([
      search('error', 'SearXNG is not reachable at http://localhost:8080.'),
      search('error', 'Rate limited by the provider.')
    ])

    expect(reason).toBe(GENERIC_RESEARCH_FAILURE)
  })

  it('stays generic when nothing was searched at all', () => {
    expect(researchFailureReason([])).toBe(GENERIC_RESEARCH_FAILURE)
    expect(researchFailureReason([{ ...search('error'), detail: undefined }])).toBe(
      GENERIC_RESEARCH_FAILURE
    )
  })

  it('ignores activities that are not searches', () => {
    // Planning and analysis failing tells you nothing about why no source was
    // fetched.
    const reason = researchFailureReason([
      { id: 'p', kind: 'planning', label: 'Plan', status: 'error', detail: 'bad', createdAt: 0 },
      search('error', 'SearXNG is not reachable at http://localhost:8080.')
    ])

    expect(reason).toContain('SearXNG is not reachable')
  })
})
