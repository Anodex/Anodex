import { describe, expect, it } from 'vitest'
import { buildHistoryItems } from '../LlamaService'
import type { ChatHistoryTurn } from '@shared/chat.types'

describe('buildHistoryItems', () => {
  it('prepends the system prompt', () => {
    const items = buildHistoryItems('be helpful', [])
    expect(items).toEqual([{ type: 'system', text: 'be helpful' }])
  })

  it('maps user and assistant turns', () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    const items = buildHistoryItems(undefined, history)
    expect(items).toEqual([
      { type: 'user', text: 'hi' },
      { type: 'model', response: ['hello'] }
    ])
  })

  it('replays an assistant turn tool call as a functionCall with its remembered result', () => {
    const history: ChatHistoryTurn[] = [
      {
        role: 'assistant',
        content: 'Done.',
        toolCalls: [
          {
            id: 't1',
            name: 'read_file',
            kind: 'read',
            title: 'Read src/index.ts',
            status: 'success',
            result: 'export const x = 1'
          }
        ]
      }
    ]

    const [modelItem] = buildHistoryItems(undefined, history)
    expect(modelItem.type).toBe('model')
    const response = (modelItem as { response: Array<unknown> }).response
    // First entry is the replayed function call, last is the final text.
    expect(response).toHaveLength(2)
    expect(response[0]).toMatchObject({
      type: 'functionCall',
      name: 'read_file',
      result: 'Read src/index.ts\nexport const x = 1'
    })
    expect(response[1]).toBe('Done.')
  })

  it('skips in-progress tool calls', () => {
    const history: ChatHistoryTurn[] = [
      {
        role: 'assistant',
        content: 'Working…',
        toolCalls: [
          {
            id: 't1',
            name: 'run_command',
            kind: 'command',
            title: 'Run: npm test',
            status: 'running'
          }
        ]
      }
    ]
    const [modelItem] = buildHistoryItems(undefined, history)
    const response = (modelItem as { response: Array<unknown> }).response
    expect(response).toEqual(['Working…'])
  })
})
