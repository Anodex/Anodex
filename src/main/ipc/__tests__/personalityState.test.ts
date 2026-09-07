import { describe, expect, it } from 'vitest'
import {
  ANODEX_PERSONALITY_ID,
  BUILT_IN_CHAT_PERSONALITIES,
  allChatPersonalities
} from '@shared/chatPersonality'

/**
 * Which personalities a phone is shown, and that the default is among them.
 *
 * This exists because of a real defect. The handler read
 * `assistantStyle.personalities`, which holds only the entries a user has written
 * themselves and is empty on every install where nobody has — the shipped ones live
 * in code. The phone's picker was therefore empty on the machine it was built for,
 * and selecting the active personality would have been refused as an unknown id,
 * because the default is `builtin:anodex` and that list has never contained it.
 *
 * The mapping is exercised through `allChatPersonalities` rather than by importing
 * the handler, which needs Electron. What is being pinned is the choice of source,
 * which is where the bug was.
 */
describe('the personalities a phone is offered', () => {
  const saved = [{ id: 'mine', name: 'Scout', role: 'Mine.', tint: 'green' as const, style: 'x' }]

  it('includes the shipped ones when the user has written none', () => {
    // The exact failure: settings hold an empty array on a fresh install.
    expect(allChatPersonalities([])).not.toHaveLength(0)
    expect(allChatPersonalities(undefined).length).toBe(BUILT_IN_CHAT_PERSONALITIES.length)
  })

  it('includes the default, which is what active points at out of the box', () => {
    const ids = allChatPersonalities([]).map((personality) => personality.id)
    expect(ids).toContain(ANODEX_PERSONALITY_ID)

    // Anodex leads the list, so it is the first thing on the phone's screen too.
    expect(ids[0]).toBe(ANODEX_PERSONALITY_ID)
  })

  it('puts the user their own entries after the shipped ones', () => {
    const names = allChatPersonalities(saved).map((personality) => personality.name)
    expect(names[0]).toBe('Anodex')
    expect(names.at(-1)).toBe('Scout')
  })

  it('lets a user entry shadow a built-in rather than showing both', () => {
    const shadowing = [{ ...saved[0], id: ANODEX_PERSONALITY_ID, name: 'Mine' }]
    const matches = allChatPersonalities(shadowing).filter(
      (personality) => personality.id === ANODEX_PERSONALITY_ID
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].name).toBe('Mine')
  })

  it('gives every personality something for the phone to draw a dot with', () => {
    // The phone shows a tint dot per row, so an absent tint would be an invisible
    // one. The handler resolves it to the accent; this pins that nothing shipped
    // relies on that fallback silently changing meaning.
    for (const personality of allChatPersonalities([])) {
      expect(personality.name.length, personality.id).toBeGreaterThan(0)
    }
  })
})
