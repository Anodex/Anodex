import { describe, expect, it } from 'vitest'
import type { AgentRun } from '../agentRun.types'
import { continuationRequestFor, latestRunOfSeries, seriesIsBusy } from '../agentContinuation'

/**
 * Advancing a series without a person pressing Continue.
 *
 * The risky part of an unattended feature is not the case it was built for,
 * it is the cases nobody pictured: the series whose runs were all deleted, the
 * one already working when the schedule fires, the one whose newest run is a
 * sub-agent. Each of those has a right answer and none of them is "start
 * another run and hope".
 */

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run_1',
    seriesId: undefined,
    parentRunId: null,
    delegatedTask: null,
    goal: 'Keep the changelog up to date',
    status: 'done',
    projectId: 'p_1',
    enabledTools: ['read_file', 'write_file'],
    provider: 'local',
    model: null,
    maxTurns: 12,
    turnsUsed: 4,
    flaggedTurns: 0,
    maxTokens: 120_000,
    tokensUsed: 900,
    maxDurationMinutes: 40,
    activeMs: 1000,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: 'conv_1',
    summary: 'Added the 0.14.0 entry.',
    lastError: null,
    requirePlan: false,
    plan: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as AgentRun
}

describe('which run the next one is modelled on', () => {
  it('is the newest run of the series', () => {
    const runs = [
      run({ id: 'a', createdAt: 1 }),
      run({ id: 'b', seriesId: 'a', createdAt: 5, maxTurns: 30 }),
      run({ id: 'c', seriesId: 'a', createdAt: 3 })
    ]
    expect(latestRunOfSeries(runs, 'a')?.id).toBe('b')
  })

  it('treats a first run as its own series', () => {
    // `seriesIdOf` falls back to the run id, so nothing downstream has to
    // special-case the run that started the work.
    expect(latestRunOfSeries([run({ id: 'a' })], 'a')?.id).toBe('a')
  })

  it('never continues from a sub-agent', () => {
    // A delegated run is a step inside its parent: its goal is one slice of
    // the real one and its tools were chosen for that slice. Continuing from
    // it would resume the slice and lose the work.
    const runs = [
      run({ id: 'parent', createdAt: 1 }),
      run({ id: 'child', parentRunId: 'parent', seriesId: 'parent', createdAt: 9 })
    ]
    expect(latestRunOfSeries(runs, 'parent')?.id).toBe('parent')
  })

  it('finds nothing for a series whose runs are gone', () => {
    expect(latestRunOfSeries([run({ id: 'other' })], 'deleted')).toBeUndefined()
  })
})

describe('the request a schedule fires', () => {
  it('inherits the shape of the work rather than inventing one', () => {
    const request = continuationRequestFor(
      [run({ id: 'a', provider: 'deepseek', model: 'deepseek-chat', maxTurns: 30 })],
      'a'
    )
    expect(request).toEqual({
      goal: 'Keep the changelog up to date',
      continuesSeriesId: 'a',
      projectId: 'p_1',
      enabledTools: ['read_file', 'write_file'],
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTurns: 30,
      maxTokens: 120_000,
      maxDurationMinutes: 40,
      limitsEnabled: true,
      requirePlan: false
    })
  })

  it('reads the newest run each time, so changing the work changes the schedule', () => {
    // The settings are not captured when the schedule is made. Continue a
    // series by hand with a bigger budget and the schedule follows, because
    // there is only one place the answer lives.
    const runs = [
      run({ id: 'a', createdAt: 1, maxTurns: 12 }),
      run({ id: 'b', seriesId: 'a', createdAt: 2, maxTurns: 40, provider: 'anthropic' })
    ]
    const request = continuationRequestFor(runs, 'a')
    expect(request).toMatchObject({ maxTurns: 40, provider: 'anthropic' })
  })

  it('keeps a plan review the user asked for', () => {
    // Silently dropping a review because nobody is watching would be exactly
    // backwards: nobody watching is when the review matters.
    const request = continuationRequestFor([run({ id: 'a', requirePlan: true })], 'a')
    expect(request).toMatchObject({ requirePlan: true })
  })

  it('copies the tool list rather than sharing it', () => {
    const original = run({ id: 'a' })
    const request = continuationRequestFor([original], 'a')
    if ('error' in request) throw new Error('expected a request')
    request.enabledTools.push('run_command')
    expect(original.enabledTools).toEqual(['read_file', 'write_file'])
  })

  it('refuses, in words, when the work it continues has been deleted', () => {
    const request = continuationRequestFor([run({ id: 'other' })], 'gone')
    expect(request).toHaveProperty('error')
    expect((request as { error: string }).error).toMatch(/no longer exists/i)
  })
})

describe('a series that is already working', () => {
  it('is busy while a run of it is running', () => {
    expect(seriesIsBusy([run({ id: 'a', status: 'running' })], 'a')).toBe(true)
  })

  it('is busy while a run of it waits for plan review', () => {
    // Not idle: a parked run is the work, waiting. Starting another would put
    // two runs on one journal and one workspace.
    expect(seriesIsBusy([run({ id: 'a', status: 'needs-review' })], 'a')).toBe(true)
  })

  it('is not busy once every run has finished, stopped or failed', () => {
    const runs = [
      run({ id: 'a', status: 'done' }),
      run({ id: 'b', seriesId: 'a', status: 'stopped' }),
      run({ id: 'c', seriesId: 'a', status: 'error' })
    ]
    expect(seriesIsBusy(runs, 'a')).toBe(false)
  })

  it('is not made busy by another series running', () => {
    expect(seriesIsBusy([run({ id: 'other', status: 'running' })], 'a')).toBe(false)
  })

  it('is not made busy by a sub-agent of another run', () => {
    // A sub-agent carries its parent's series id. It is its parent that is
    // busy, and the parent is already counted.
    const runs = [run({ id: 'child', parentRunId: 'p', seriesId: 'a', status: 'running' })]
    expect(seriesIsBusy(runs, 'a')).toBe(false)
  })
})
