import { describe, expect, it } from 'vitest'
import { buildHistoryItems } from '../LlamaService'
import type { ChatHistoryTurn } from '@shared/chat.types'
import { MAX_MODEL_TOOL_RESULT_CHARS } from '../contextAssembler'

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

  it('bounds replayed tool results so rebuilt sessions do not overflow with old output', () => {
    const history: ChatHistoryTurn[] = [
      {
        role: 'assistant',
        content: 'Read it.',
        toolCalls: [
          {
            id: 't1',
            name: 'read_file',
            kind: 'read',
            title: 'Read huge.log',
            status: 'success',
            result: 'x'.repeat(MAX_MODEL_TOOL_RESULT_CHARS + 500)
          }
        ]
      }
    ]

    const [modelItem] = buildHistoryItems(undefined, history)
    const response = (modelItem as { response: Array<{ result?: string } | string> }).response
    expect(typeof response[0]).toBe('object')
    expect((response[0] as { result: string }).result).toContain('Anodex truncated')
    expect((response[0] as { result: string }).result.length).toBeLessThan(
      MAX_MODEL_TOOL_RESULT_CHARS + 500
    )
  })

  it('strips raw tool payloads from assistant text before replay', () => {
    const history: ChatHistoryTurn[] = [
      {
        role: 'assistant',
        content: 'I will patch it now.\n{"name": "patch_file", "arguments": {"path": "app.css"}}'
      }
    ]

    const [modelItem] = buildHistoryItems(undefined, history)
    const response = (modelItem as { response: Array<unknown> }).response
    expect(response).toEqual(['I will patch it now.'])
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
