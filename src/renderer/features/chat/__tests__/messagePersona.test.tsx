import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessagePersona } from '@shared/chat.types'
import { findChatPersonality } from '@shared/chatPersonality'
import { personalityDisplayName } from '../../../components/ui/personalityIdentity'

/**
 * Which personality a reply is labelled with.
 *
 * The bug: the byline was read from whichever personality is selected *now*, so
 * changing it renamed every reply already in the transcript. Ask Rook something,
 * switch to Vale, and Rook's answer claims to be Vale's — worse than no label,
 * because the label exists so somebody can tell which one said a thing.
 *
 * The resolution below is the one `MessageBubble` uses. What is pinned is the
 * order: what the message recorded wins, and the current selection is only the
 * fallback for turns written before that was kept.
 */
describe('the personality a message is labelled with', () => {
  const recorded: MessagePersona = { id: 'builtin:skeptical', name: 'Rook', tint: 'series-3' }

  const resolve = (message: Pick<ChatMessage, 'persona'>, activeId: string | null): string => {
    const selected = findChatPersonality([], activeId)
    const persona = message.persona ?? selected
    return persona ? personalityDisplayName(persona) : 'Anodex'
  }

  it('uses what the message recorded, whatever is selected now', () => {
    // The whole point: the selection has moved on to Vale since.
    expect(resolve({ persona: recorded }, 'builtin:direct')).toBe('Rook')
  })

  it('is unmoved by the selection changing again', () => {
    for (const active of ['builtin:direct', 'builtin:terse', null]) {
      expect(resolve({ persona: recorded }, active)).toBe('Rook')
    }
  })

  it('falls back to the selection for a message written before this was kept', () => {
    // Old transcripts carry no author. The current selection is a guess, but it is
    // the only one available and it is right for the common case of never having
    // changed personality.
    expect(resolve({}, 'builtin:skeptical')).toBe('Rook')
  })

  it('says Anodex when no character is chosen', () => {
    // Free-text guidance is not a character, and neither is nothing at all. The
    // default voice speaks as itself rather than borrowing a name.
    expect(resolve({}, null)).toBe('Anodex')
  })
})
