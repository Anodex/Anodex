import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import { RUN_TURN_TEXT_CHARS, RUN_TURN_TOOLS, runTurnsForRemote } from '../runTurnsForRemote'

function reply(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm', role: 'assistant', content: 'Listed the folders.', createdAt: 1, ...overrides }
}

describe('runTurnsForRemote', () => {
  it('makes each assistant message a numbered turn, skipping the prompts', () => {
    const turns = runTurnsForRemote([
      { id: 'u1', role: 'user', content: 'Start', createdAt: 1 },
      reply({ id: 'a1', stats: { tokens: 316, durationMs: 14_500, tokensPerSecond: 21 } }),
      { id: 'u2', role: 'user', content: 'Continue', createdAt: 2 },
      reply({ id: 'a2', content: 'Done.' })
    ])

    expect(turns.map((turn) => [turn.number, turn.messageId, turn.text])).toEqual([
      [1, 'a1', 'Listed the folders.'],
      [2, 'a2', 'Done.']
    ])
    expect(turns[0]).toMatchObject({ tokens: 316, durationMs: 14_500 })
    expect(turns[1]).toMatchObject({ tokens: null, durationMs: null })
  })

  it('keeps tool names, titles and outcomes, and nothing else about them', () => {
    const [turn] = runTurnsForRemote([
      reply({
        toolCalls: [
          {
            id: 't1',
            name: 'list_directory',
            kind: 'read',
            title: 'List .',
            status: 'success',
            result: 'src\ndist'
          },
          { id: 't2', name: 'finish_goal', kind: 'plan', title: 'Finish goal', status: 'error' }
        ]
      })
    ])

    expect(turn.tools).toEqual([
      { name: 'list_directory', title: 'List .', status: 'success' },
      { name: 'finish_goal', title: 'Finish goal', status: 'error' }
    ])
    expect(JSON.stringify(turn)).not.toContain('dist')
    expect(turn.health).toBe('warn')
  })

  it('caps a long reply and a turn with many tools', () => {
    const calls = Array.from({ length: RUN_TURN_TOOLS + 5 }, (_, index) => ({
      id: `t${index}`,
      name: 'read_file',
      kind: 'read' as const,
      title: `Read ${index}`,
      status: 'success' as const
    }))
    const [turn] = runTurnsForRemote([
      reply({ content: 'x'.repeat(RUN_TURN_TEXT_CHARS * 2), toolCalls: calls })
    ])

    expect(turn.text.length).toBe(RUN_TURN_TEXT_CHARS + 1)
    expect(turn.tools).toHaveLength(RUN_TURN_TOOLS)
    expect(turn.moreTools).toBe(5)
  })

  it('colours a failed turn the way the desktop run page does', () => {
    const [failed, bounded] = runTurnsForRemote([
      reply({ error: 'provider failed' }),
      reply({ error: 'budget reached', errorKind: 'bounded' })
    ])
    expect(failed.health).toBe('error')
    expect(bounded.health).toBe('warn')
  })
})
