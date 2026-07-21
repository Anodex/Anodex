import { describe, expect, it } from 'vitest'
import { TokenBatcher } from '../tokenBatcher'

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

    batcher.drain()

    expect(batcher.hasPending()).toBe(false)
    const second = batcher.drain()
    expect(second.tokens).toEqual([])
    expect(second.thinkingTokens).toEqual([])
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
