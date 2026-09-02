import { describe, expect, it } from 'vitest'
import { findStatedName, identityToCapture } from '../statedIdentity'

/**
 * A deliberately narrow detector, and the tests are mostly about what it must
 * *not* match.
 *
 * It exists because of a measured gap: across three runs of an eight-model chat
 * matrix, only five of twenty-four model-runs called `remember_fact` after the
 * user said "My name is Merlin and I prefer short answers". Six models replied
 * "Got it, Merlin" and stored nothing. The failure is silent — the name is
 * still in the conversation, so recall works for the rest of the session and
 * only the *next* conversation reveals that nothing was saved.
 *
 * Reframing the prompt rule and then the tool description each moved exactly
 * one model. So the backstop is deterministic rather than another attempt to
 * persuade a model, and it is kept to the one phrasing that cannot be mistaken
 * for anything else. A wrong capture writes a false fact into memory that then
 * gets recalled in every future chat, which is far worse than missing one.
 */
describe('findStatedName', () => {
  describe('captures an unambiguous self-introduction', () => {
    it.each([
      ['My name is Merlin', 'Merlin'],
      ['my name is Merlin and I prefer short answers.', 'Merlin'],
      ["My name's Merlin", 'Merlin'],
      ['Call me Merlin', 'Merlin'],
      ['Okay, out of character now. My name is Merlin.', 'Merlin'],
      ['my name is Mary-Jane', 'Mary-Jane'],
      ["my name is O'Brien", "O'Brien"]
    ])('%s', (input, expected) => {
      expect(findStatedName(input)).toBe(expected)
    })
  })

  describe('refuses anything that is not the user naming themselves', () => {
    it.each([
      ['someone else', 'His name is Bob'],
      ['a third party', "The dog's name is Rex"],
      ['a negation', 'My name is not important'],
      ['a deflection', "My name is a bit unusual, I won't bother you with it"],
      ['a question', 'What is my name?'],
      ['a request about naming', 'Can you call me back later'],
      ['a lowercase common word', 'my name is just a placeholder'],
      ['no name at all', 'I prefer short answers'],
      ['a file path', 'my name is in config.json'],
      ['empty', '']
    ])('%s', (_label, input) => {
      expect(findStatedName(input)).toBeNull()
    })
  })

  describe('bounds', () => {
    it('rejects an absurdly long capture rather than storing a sentence', () => {
      expect(findStatedName(`My name is ${'A'.repeat(60)}`)).toBeNull()
    })

    it('rejects a single letter, which is far more often a typo than a name', () => {
      expect(findStatedName('My name is A')).toBeNull()
    })

    it('takes only the first name-shaped token, not the rest of the sentence', () => {
      expect(findStatedName('My name is Merlin Shaw and I live here')).toBe('Merlin')
    })

    it('ignores a name mentioned later in a long message it did not introduce', () => {
      expect(findStatedName('Rename the file to Merlin.txt please')).toBeNull()
    })
  })
})

describe('identityToCapture', () => {
  const base = { surface: 'chat', prompt: 'My name is Merlin', calledTools: [] as string[] }

  it('captures on the chat surface when the model saved nothing', () => {
    expect(identityToCapture(base)).toBe('Merlin')
  })

  it('stays out of the way when the model already called remember_fact', () => {
    // The model handled it. A second write would sit next to the first saying
    // the same thing in slightly different words.
    expect(identityToCapture({ ...base, calledTools: ['remember_fact'] })).toBeNull()
  })

  it('never captures outside chat', () => {
    // An agent run editing a file that contains "my name is X" must not write
    // that into the user's global memory.
    expect(identityToCapture({ ...base, surface: undefined })).toBeNull()
    expect(identityToCapture({ ...base, surface: 'agent' })).toBeNull()
  })

  it('captures nothing from an ordinary message', () => {
    expect(identityToCapture({ ...base, prompt: 'What is a list comprehension?' })).toBeNull()
  })
})
