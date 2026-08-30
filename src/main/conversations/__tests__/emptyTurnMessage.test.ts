import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import { carriesNothing } from '../backgroundTurn'

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    ...overrides
  }
}

describe('carriesNothing', () => {
  // Measured: four agent runs end with an empty assistant message carrying
  // {tokens: 0, durationMs: 1} - no generation happened at all - which renders
  // as an empty bubble in the transcript.
  it('is true for an empty message that recorded nothing', () => {
    expect(
      carriesNothing(assistant({ stats: { tokens: 0, durationMs: 1, tokensPerSecond: 0 } }))
    ).toBe(true)
  })

  it('is true for a completely bare message', () => {
    expect(carriesNothing(assistant())).toBe(true)
  })

  // Everything below is why this is not simply "drop empty messages". Blanks in
  // the store were found carrying real data, and one held 6,579 characters of
  // reasoning alongside an error.
  it('is false when the message holds reasoning', () => {
    expect(carriesNothing(assistant({ thinking: 'a long chain of thought' }))).toBe(false)
  })

  it('is false when the message records an error', () => {
    expect(carriesNothing(assistant({ error: 'model failed to load' }))).toBe(false)
  })

  it('is false when there are tool calls', () => {
    expect(
      carriesNothing(
        assistant({
          toolCalls: [
            { id: 't', name: 'read_file', kind: 'read', title: 'Read a', status: 'success' }
          ]
        })
      )
    ).toBe(false)
  })

  it('is false when there is visible content', () => {
    expect(carriesNothing(assistant({ content: 'Done.' }))).toBe(false)
  })

  it('treats whitespace-only content as empty', () => {
    expect(carriesNothing(assistant({ content: '   \n  ' }))).toBe(true)
  })

  it('never drops a user message, whatever it holds', () => {
    expect(carriesNothing(assistant({ role: 'user' }))).toBe(false)
  })
})
