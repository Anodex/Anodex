import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_CHAT_PERSONALITIES,
  MAX_PERSONALITY_NAME_CHARS,
  allChatPersonalities,
  findChatPersonality,
  isBuiltInPersonalityId,
  normalizePersonalityName,
  resolveActiveStyle
} from '../chatPersonality'

/**
 * A personality is a *named* saved voice, and the whole point of naming it is
 * that the name outlives the session. That makes two things load-bearing and
 * worth pinning down here rather than discovering in a chat:
 *
 * 1. Which text actually reaches the system prompt. `resolveActiveStyle` is the
 *    single reader — `assistantStyle.globalStyle` is no longer read directly,
 *    precisely so a selected personality and the stored free text can never
 *    disagree about which one is in force.
 * 2. What happens to a selection whose target is gone. Deleting the active
 *    personality leaves a dangling id in settings, and a dangling id must
 *    degrade to the free-text style rather than throwing or blanking the voice.
 */
describe('chatPersonality', () => {
  const saved = [
    { id: 'p1', name: 'Ada', style: 'Speak like a patient tutor.' },
    { id: 'p2', name: 'Duck', style: 'Only ask questions, never answer.' }
  ]

  describe('resolveActiveStyle', () => {
    it('uses the active personality style, not the stored free text', () => {
      expect(resolveActiveStyle({ saved, activeId: 'p2', globalStyle: 'stale free text' })).toBe(
        'Only ask questions, never answer.'
      )
    })

    it('falls back to the free text when nothing is selected', () => {
      expect(resolveActiveStyle({ saved, activeId: null, globalStyle: 'be terse' })).toBe(
        'be terse'
      )
    })

    it('falls back to the free text when the active personality was deleted', () => {
      // The dangling-id case: settings still names `p9` after a delete, and the
      // user must not silently lose their voice guidance over it.
      expect(resolveActiveStyle({ saved, activeId: 'p9', globalStyle: 'be terse' })).toBe(
        'be terse'
      )
    })

    it('resolves a built-in personality without it being in saved', () => {
      // Built-ins live in code, never in settings, so a fresh install can
      // select one before it has saved anything of its own.
      const builtIn = BUILT_IN_CHAT_PERSONALITIES[0]
      expect(resolveActiveStyle({ saved: [], activeId: builtIn.id, globalStyle: '' })).toBe(
        builtIn.style
      )
    })

    it('returns empty string rather than null when there is no style at all', () => {
      // The prompt composer checks `.trim()`, so an empty string is the shape
      // that cleanly means "add no Assistant style section".
      expect(resolveActiveStyle({ saved: [], activeId: null, globalStyle: '' })).toBe('')
    })

    it('lets a saved personality shadow a built-in id', () => {
      // If a built-in id is ever retired from code, a user copy under the same
      // id keeps working instead of vanishing.
      const builtIn = BUILT_IN_CHAT_PERSONALITIES[0]
      const shadow = [{ id: builtIn.id, name: 'Mine', style: 'my own words' }]
      expect(resolveActiveStyle({ saved: shadow, activeId: builtIn.id, globalStyle: '' })).toBe(
        'my own words'
      )
    })
  })

  describe('allChatPersonalities', () => {
    it('lists built-ins before saved ones', () => {
      const all = allChatPersonalities(saved)
      expect(all.slice(0, BUILT_IN_CHAT_PERSONALITIES.length)).toEqual(BUILT_IN_CHAT_PERSONALITIES)
      expect(all.slice(BUILT_IN_CHAT_PERSONALITIES.length)).toEqual(saved)
    })

    it('does not list a built-in twice when a saved copy shadows it', () => {
      const builtIn = BUILT_IN_CHAT_PERSONALITIES[0]
      const shadow = [{ id: builtIn.id, name: 'Mine', style: 'my own words' }]
      const ids = allChatPersonalities(shadow).map((item) => item.id)
      expect(ids.filter((id) => id === builtIn.id)).toHaveLength(1)
    })

    it('survives settings holding no personalities', () => {
      expect(allChatPersonalities([])).toEqual(BUILT_IN_CHAT_PERSONALITIES)
      expect(allChatPersonalities(undefined)).toEqual(BUILT_IN_CHAT_PERSONALITIES)
    })
  })

  describe('findChatPersonality', () => {
    it('finds a saved one', () => {
      expect(findChatPersonality(saved, 'p1')?.name).toBe('Ada')
    })

    it('returns null for an unknown id', () => {
      expect(findChatPersonality(saved, 'nope')).toBeNull()
    })

    it('returns null for a null id rather than guessing a default', () => {
      expect(findChatPersonality(saved, null)).toBeNull()
    })
  })

  describe('isBuiltInPersonalityId', () => {
    it('recognises the shipped ids', () => {
      expect(isBuiltInPersonalityId(BUILT_IN_CHAT_PERSONALITIES[0].id)).toBe(true)
    })

    it('rejects a user id', () => {
      expect(isBuiltInPersonalityId('p1')).toBe(false)
    })
  })

  describe('normalizePersonalityName', () => {
    it('trims surrounding whitespace', () => {
      expect(normalizePersonalityName('  Ada  ')).toBe('Ada')
    })

    it('collapses newlines so a name stays one line in a picker', () => {
      expect(normalizePersonalityName('Ada\nLovelace')).toBe('Ada Lovelace')
    })

    it('caps an over-long name at the documented limit', () => {
      const long = 'x'.repeat(MAX_PERSONALITY_NAME_CHARS + 20)
      expect(normalizePersonalityName(long)).toHaveLength(MAX_PERSONALITY_NAME_CHARS)
    })

    it('returns empty for a name that is only whitespace', () => {
      // The caller decides what to do about it; this function does not invent
      // a placeholder name the user never typed.
      expect(normalizePersonalityName('   ')).toBe('')
    })
  })

  describe('the shipped personalities themselves', () => {
    it('all carry a built-in id, a name and non-empty style text', () => {
      for (const personality of BUILT_IN_CHAT_PERSONALITIES) {
        expect(isBuiltInPersonalityId(personality.id)).toBe(true)
        expect(personality.name.trim()).not.toBe('')
        expect(personality.style.trim()).not.toBe('')
      }
    })

    it('have unique ids', () => {
      const ids = BUILT_IN_CHAT_PERSONALITIES.map((item) => item.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('have names short enough for the picker', () => {
      for (const personality of BUILT_IN_CHAT_PERSONALITIES) {
        expect(personality.name.length).toBeLessThanOrEqual(MAX_PERSONALITY_NAME_CHARS)
      }
    })
  })
})
