import { describe, expect, it } from 'vitest'
import { createTokenCoalescer } from '../tokenCoalescer'

function harness() {
  const sent: Array<[string, unknown]> = []
  let pending: (() => void) | null = null
  const coalescer = createTokenCoalescer({
    emit: (channel, payload) => sent.push([channel, payload]),
    setTimer: (callback) => {
      pending = callback
      return 1
    },
    clearTimer: () => {
      pending = null
    }
  })
  return {
    coalescer,
    sent,
    tick: (): void => {
      const run = pending
      pending = null
      run?.()
    }
  }
}

const token = (text: string, messageId = 'm1') => ({ conversationId: 'c1', messageId, token: text })

describe('createTokenCoalescer', () => {
  it('sends a burst of tokens as one frame with the same text', () => {
    const { coalescer, sent, tick } = harness()
    coalescer.event('chat:stream', token('Hel'))
    coalescer.event('chat:stream', token('lo'))
    coalescer.event('chat:stream', token(' there'))
    expect(sent).toEqual([])

    tick()
    expect(sent).toEqual([['chat:stream', token('Hello there')]])
  })

  it('sends what it holds before anything else, so order never changes', () => {
    // A tool starting after some words must still arrive after them.
    const { coalescer, sent } = harness()
    coalescer.event('chat:stream', token('Let me look.'))
    coalescer.event('tools:activity', { conversationId: 'c1', call: { id: 't1' } })
    expect(sent).toEqual([
      ['chat:stream', token('Let me look.')],
      ['tools:activity', { conversationId: 'c1', call: { id: 't1' } }]
    ])
  })

  it('keeps thinking and reply apart, in the order they were written', () => {
    const { coalescer, sent, tick } = harness()
    coalescer.event('chat:thinking-stream', token('hm'))
    coalescer.event('chat:stream', token('Yes'))
    coalescer.event('chat:thinking-stream', token('again'))
    tick()
    expect(sent.map(([channel]) => channel)).toEqual([
      'chat:thinking-stream',
      'chat:stream',
      'chat:thinking-stream'
    ])
  })

  it('never joins two turns', () => {
    const { coalescer, sent, tick } = harness()
    coalescer.event('chat:stream', token('a', 'm1'))
    coalescer.event('chat:stream', token('b', 'm2'))
    tick()
    expect(sent).toEqual([
      ['chat:stream', token('a', 'm1')],
      ['chat:stream', token('b', 'm2')]
    ])
  })

  it('sends a frame with anything more than a token as it is, after what it holds', () => {
    // The thinking so far, which replaces what the phone holds, must not be joined.
    const { coalescer, sent } = harness()
    coalescer.event('chat:thinking-stream', token('late'))
    const catchUp = { ...token('all of it'), replace: true }
    coalescer.event('chat:thinking-stream', catchUp)
    expect(sent).toEqual([
      ['chat:thinking-stream', token('late')],
      ['chat:thinking-stream', catchUp]
    ])
  })

  it('sends at once when a lot is held', () => {
    const { coalescer, sent } = harness()
    coalescer.event('chat:stream', token('x'.repeat(16_000)))
    expect(sent).toHaveLength(1)
  })

  it('drops what it holds once disposed', () => {
    const { coalescer, sent, tick } = harness()
    coalescer.event('chat:stream', token('gone'))
    coalescer.dispose()
    tick()
    coalescer.flush()
    expect(sent).toEqual([])
  })
})
