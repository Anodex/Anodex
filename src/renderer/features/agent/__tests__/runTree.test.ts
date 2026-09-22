import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import { describeSubAgents, groupRunsByParent, seriesPlaces } from '../runTree'

function run(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    goal: `Goal ${id}`,
    status: 'done',
    projectId: null,
    enabledTools: [],
    provider: 'local',
    model: null,
    maxTurns: 8,
    turnsUsed: 1,
    flaggedTurns: 0,
    maxTokens: 50_000,
    tokensUsed: 0,
    maxDurationMinutes: 30,
    activeMs: 0,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: `conv-${id}`,
    summary: null,
    lastError: null,
    requirePlan: false,
    plan: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('groupRunsByParent', () => {
  it('nests each sub-agent under the run that delegated it', () => {
    const nodes = groupRunsByParent([
      run('parent'),
      run('child-a', { parentRunId: 'parent' }),
      run('child-b', { parentRunId: 'parent' }),
      run('other')
    ])

    expect(nodes.map((node) => node.run.id)).toEqual(['parent', 'other'])
    expect(nodes[0].children.map((child) => child.id)).toEqual(['child-a', 'child-b'])
    expect(nodes[1].children).toEqual([])
  })

  it('shows a sub-agent at the top level when its parent is not on screen', () => {
    // The status filter is applied before this runs, so a finished sub-agent
    // of a still-running parent arrives here alone. It is a real run with a
    // transcript — appearing out of place beats not appearing at all.
    const nodes = groupRunsByParent([run('child', { parentRunId: 'parent' })])

    expect(nodes.map((node) => node.run.id)).toEqual(['child'])
  })

  it('does not lose a sub-agent whose parent was deleted', () => {
    const nodes = groupRunsByParent([run('orphan', { parentRunId: 'gone' }), run('normal')])

    expect(nodes.map((node) => node.run.id)).toEqual(['orphan', 'normal'])
  })

  it('keeps the order runs arrived in', () => {
    const nodes = groupRunsByParent([
      run('newest'),
      run('newest-child', { parentRunId: 'newest' }),
      run('older'),
      run('older-child', { parentRunId: 'older' })
    ])

    expect(nodes.map((node) => node.run.id)).toEqual(['newest', 'older'])
    expect(nodes[0].children.map((child) => child.id)).toEqual(['newest-child'])
    expect(nodes[1].children.map((child) => child.id)).toEqual(['older-child'])
  })

  it('handles an empty list', () => {
    expect(groupRunsByParent([])).toEqual([])
  })
})

describe('describeSubAgents', () => {
  it('says nothing for a run that delegated nothing', () => {
    expect(describeSubAgents([])).toBeNull()
  })

  it('counts how many are still working', () => {
    const line = describeSubAgents([
      run('a', { status: 'running' }),
      run('b', { status: 'running' }),
      run('c')
    ])
    expect(line).toBe('3 sub-agents · 2 working')
  })

  it('reports failures only once they have all stopped', () => {
    // While one is still working, the count of failures is a progress report
    // rather than an outcome.
    expect(
      describeSubAgents([run('a', { status: 'error' }), run('b', { status: 'running' })])
    ).toBe('2 sub-agents · 1 working')
    expect(describeSubAgents([run('a', { status: 'error' }), run('b')])).toBe(
      '2 sub-agents · 1 did not finish'
    )
  })

  it('counts a stopped sub-agent as one that did not finish', () => {
    expect(describeSubAgents([run('a', { status: 'stopped' })])).toBe(
      '1 sub-agent · 1 did not finish'
    )
  })

  it('says so plainly when they all finished', () => {
    expect(describeSubAgents([run('a'), run('b')])).toBe('2 sub-agents · all finished')
  })
})

describe('seriesPlaces', () => {
  it('numbers the runs of an ongoing piece of work, oldest first', () => {
    const places = seriesPlaces([
      run('third', { seriesId: 's', createdAt: 300 }),
      run('first', { seriesId: 's', createdAt: 100 }),
      run('second', { seriesId: 's', createdAt: 200 })
    ])
    expect(places.get('first')).toEqual({ position: 1, total: 3 })
    expect(places.get('second')).toEqual({ position: 2, total: 3 })
    expect(places.get('third')).toEqual({ position: 3, total: 3 })
  })

  it('says nothing about a run that stands alone', () => {
    // A lone run is a series of one, so "run 1 of 1" would be true and
    // useless — a mark that appears on everything marks nothing.
    expect(seriesPlaces([run('only', { seriesId: 'only' })]).size).toBe(0)
  })

  it('treats a run with no series as its own', () => {
    // Runs recorded before series existed.
    expect(seriesPlaces([run('old'), run('older')]).size).toBe(0)
  })

  it('leaves sub-agents out of the count', () => {
    // A sub-agent is a step inside one chapter, not a chapter of its own.
    const places = seriesPlaces([
      run('parent-a', { seriesId: 's', createdAt: 100 }),
      run('child', { seriesId: 's', parentRunId: 'parent-a', createdAt: 150 }),
      run('parent-b', { seriesId: 's', createdAt: 200 })
    ])
    expect(places.get('parent-b')).toEqual({ position: 2, total: 2 })
    expect(places.has('child')).toBe(false)
  })
})
