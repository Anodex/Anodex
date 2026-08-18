import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/tools.types'
import { TokenBatcher } from '../tokenBatcher'

function call(id: string, status: ToolCall['status'] = 'running'): ToolCall {
  return { id, name: 'read_file_range', kind: 'read', title: `Read file (${id})`, status }
}

describe('TokenBatcher', () => {
  it('has nothing pending before an event arrives and clears after draining', () => {
    const batcher = new TokenBatcher()
    expect(batcher.hasPending()).toBe(false)

    batcher.addToken('conv-1', 'msg-1', 'hello')
    expect(batcher.hasPending()).toBe(true)

    batcher.drain()
    expect(batcher.hasPending()).toBe(false)
    expect(batcher.drain()).toEqual([])
  })

  it('coalesces only adjacent events of the same text channel', () => {
    const batcher = new TokenBatcher()
    batcher.addToken('conv-1', 'msg-1', 'Hel')
    batcher.addToken('conv-1', 'msg-1', 'lo')
    batcher.addThinkingToken('conv-1', 'msg-1', ' plan')
    batcher.addThinkingToken('conv-1', 'msg-1', ' first')
    batcher.addToken('conv-1', 'msg-1', ' again')

    expect(batcher.drain()).toEqual([
      [
        'msg-1',
        {
          conversationId: 'conv-1',
          events: [
            { type: 'text', text: 'Hello' },
            { type: 'thinking', text: ' plan first' },
            { type: 'text', text: ' again' }
          ]
        }
      ]
    ])
  })

  it('preserves text, thinking, and tool activity in their exact arrival order', () => {
    const batcher = new TokenBatcher()
    batcher.addToken('conv-1', 'msg-1', 'Let')
    batcher.addThinkingToken('conv-1', 'msg-1', ' the plan')
    batcher.addToken('conv-1', 'msg-1', ' me check')
    batcher.addToolActivity('conv-1', 'msg-1', call('call-1'))
    batcher.addToken('conv-1', 'msg-1', ' the files.')

    const [, entry] = batcher.drain()[0]
    expect(entry.events.map((event) => event.type)).toEqual([
      'text',
      'thinking',
      'text',
      'activity',
      'text'
    ])
  })

  it('keeps a repeated call in its chronological slot while replacing its status', () => {
    const batcher = new TokenBatcher()
    batcher.addToolActivity('conv-1', 'msg-1', call('call-1', 'running'))
    batcher.addToken('conv-1', 'msg-1', 'working')
    batcher.addToolActivity('conv-1', 'msg-1', call('call-2', 'running'))
    batcher.addToolActivity('conv-1', 'msg-1', call('call-1', 'success'))

    const [, entry] = batcher.drain()[0]
    expect(entry.events).toEqual([
      { type: 'activity', calls: [call('call-1', 'success')] },
      { type: 'text', text: 'working' },
      { type: 'activity', calls: [call('call-2', 'running')] }
    ])
  })

  it('keeps separate messages independent and starts fresh after a drain', () => {
    const batcher = new TokenBatcher()
    batcher.addToken('conv-1', 'msg-1', 'a')
    batcher.addToken('conv-2', 'msg-2', 'b')
    expect(batcher.drain().map(([messageId]) => messageId)).toEqual(['msg-1', 'msg-2'])

    batcher.addToken('conv-1', 'msg-1', 'second')
    expect(batcher.drain()).toEqual([
      ['msg-1', { conversationId: 'conv-1', events: [{ type: 'text', text: 'second' }] }]
    ])
  })
})
