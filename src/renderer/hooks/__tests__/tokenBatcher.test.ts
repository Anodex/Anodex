import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/tools.types'
import { TokenBatcher } from '../tokenBatcher'

function call(id: string, status: ToolCall['status'] = 'running'): ToolCall {
  return { id, name: 'read_file_range', kind: 'read', title: `Read file (${id})`, status }
}

describe('TokenBatcher', () => {
  it('has nothing pending before any token arrives', () => {
    const batcher = new TokenBatcher()
    expect(batcher.hasPending()).toBe(false)
  })

  it('reports pending work once a token is added', () => {
    const batcher = new TokenBatcher()
    batcher.addToken('conv-1', 'msg-1', 'a')
    expect(batcher.hasPending()).toBe(true)
  })

  it('concatenates multiple tokens for the same message in arrival order', () => {
    const batcher = new TokenBatcher()
    batcher.addToken('conv-1', 'msg-1', 'Hel')
    batcher.addToken('conv-1', 'msg-1', 'lo')
    batcher.addToken('conv-1', 'msg-1', '!')

    const { tokens } = batcher.drain()

    expect(tokens).toEqual([['msg-1', { conversationId: 'conv-1', text: 'Hello!' }]])
  })

  it('keeps separate messages independent', () => {
    const batcher = new TokenBatcher()
    batcher.addToken('conv-1', 'msg-1', 'a')
    batcher.addToken('conv-2', 'msg-2', 'b')

    const { tokens } = batcher.drain()

    expect(tokens).toHaveLength(2)
    expect(Object.fromEntries(tokens)).toEqual({
      'msg-1': { conversationId: 'conv-1', text: 'a' },
      'msg-2': { conversationId: 'conv-2', text: 'b' }
    })
  })

  it('keeps thinking tokens in a separate bucket from regular tokens', () => {
    const batcher = new TokenBatcher()
    batcher.addToken('conv-1', 'msg-1', 'visible')
    batcher.addThinkingToken('conv-1', 'msg-1', 'thought')

    const { tokens, thinkingTokens } = batcher.drain()

    expect(tokens).toEqual([['msg-1', { conversationId: 'conv-1', text: 'visible' }]])
    expect(thinkingTokens).toEqual([['msg-1', { conversationId: 'conv-1', text: 'thought' }]])
  })

  it('clears all state after a drain, leaving nothing pending', () => {
    const batcher = new TokenBatcher()
    batcher.addToken('conv-1', 'msg-1', 'a')
    batcher.addThinkingToken('conv-1', 'msg-1', 'b')
    batcher.addToolActivity('conv-1', 'msg-1', call('call-1'))

    batcher.drain()

    expect(batcher.hasPending()).toBe(false)
    const second = batcher.drain()
    expect(second.tokens).toEqual([])
    expect(second.thinkingTokens).toEqual([])
    expect(second.activity).toEqual([])
  })

  describe('tool activity', () => {
    it('reports pending work once a tool-activity event is added', () => {
      const batcher = new TokenBatcher()
      batcher.addToolActivity('conv-1', 'msg-1', call('call-1'))
      expect(batcher.hasPending()).toBe(true)
    })

    it('buffers several distinct calls for one message into one drain entry', () => {
      const batcher = new TokenBatcher()
      batcher.addToolActivity('conv-1', 'msg-1', call('call-1'))
      batcher.addToolActivity('conv-1', 'msg-1', call('call-2'))

      const { activity } = batcher.drain()

      expect(activity).toHaveLength(1)
      const [messageId, conversationId, calls] = activity[0]
      expect(messageId).toBe('msg-1')
      expect(conversationId).toBe('conv-1')
      expect(calls.map((c) => c.id)).toEqual(['call-1', 'call-2'])
    })

    it('keeps a repeat call for the same id in its original position but with the latest status', () => {
      const batcher = new TokenBatcher()
      batcher.addToolActivity('conv-1', 'msg-1', call('call-1', 'running'))
      batcher.addToolActivity('conv-1', 'msg-1', call('call-2', 'running'))
      // call-1 settles after call-2 started — its position should stay first.
      batcher.addToolActivity('conv-1', 'msg-1', call('call-1', 'success'))

      const { activity } = batcher.drain()
      const [, , calls] = activity[0]

      expect(calls.map((c) => c.id)).toEqual(['call-1', 'call-2'])
      expect(calls[0].status).toBe('success')
      expect(calls[1].status).toBe('running')
    })

    it('keeps activity for separate messages independent', () => {
      const batcher = new TokenBatcher()
      batcher.addToolActivity('conv-1', 'msg-1', call('call-1'))
      batcher.addToolActivity('conv-2', 'msg-2', call('call-2'))

      const { activity } = batcher.drain()

      expect(activity).toHaveLength(2)
    })
  })

  it('starts a fresh accumulation for a message after it was drained', () => {
    const batcher = new TokenBatcher()
    batcher.addToken('conv-1', 'msg-1', 'first batch')
    batcher.drain()

    batcher.addToken('conv-1', 'msg-1', 'second batch')
    const { tokens } = batcher.drain()

    expect(tokens).toEqual([['msg-1', { conversationId: 'conv-1', text: 'second batch' }]])
  })
})
