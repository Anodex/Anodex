import { describe, expect, it } from 'vitest'
import { endThinking, noteThinking, thinkingSoFar } from '../liveThinking'

describe('liveThinking', () => {
  it('holds the thinking of each running turn until it ends', () => {
    // What a phone opening the thinking partway through a turn is sent first.
    noteThinking('c1', 'm1', 'First, ')
    noteThinking('c1', 'm1', 'the question.')
    noteThinking('c2', 'm9', 'Elsewhere.')
    expect(thinkingSoFar()).toEqual([
      { conversationId: 'c1', messageId: 'm1', text: 'First, the question.' },
      { conversationId: 'c2', messageId: 'm9', text: 'Elsewhere.' }
    ])

    endThinking('c1', 'm1')
    endThinking('c2', 'm9')
    expect(thinkingSoFar()).toEqual([])
  })

  it('starts again for the next turn in the same conversation', () => {
    noteThinking('c1', 'm1', 'old')
    noteThinking('c1', 'm2', 'new')
    // The first turn ending late must not take the second one's thinking with it.
    endThinking('c1', 'm1')
    expect(thinkingSoFar()).toEqual([{ conversationId: 'c1', messageId: 'm2', text: 'new' }])
    endThinking('c1', 'm2')
  })
})
