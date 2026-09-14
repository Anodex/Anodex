import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import { conversationsOfChangedRuns } from '../changedRunConversations'

const run = (id: string, updatedAt: number, conversationId: string | null = `conv-${id}`) =>
  ({ id, updatedAt, conversationId }) as AgentRun

describe('conversationsOfChangedRuns', () => {
  it('names only the conversations of runs that changed', () => {
    // A run announces itself once per turn; the other runs have not moved.
    expect(
      conversationsOfChangedRuns([run('a', 1), run('b', 1)], [run('a', 2), run('b', 1)])
    ).toEqual(['conv-a'])
  })

  it('names a new run that already has its conversation', () => {
    expect(conversationsOfChangedRuns([], [run('a', 1)])).toEqual(['conv-a'])
  })

  it('asks for everything when a run went away or a new one has no conversation yet', () => {
    expect(conversationsOfChangedRuns([run('a', 1)], [])).toBeNull()
    expect(conversationsOfChangedRuns([], [run('a', 1, null)])).toBeNull()
  })

  it('names nothing when nothing changed', () => {
    expect(conversationsOfChangedRuns([run('a', 1)], [run('a', 1)])).toEqual([])
  })
})
