import { describe, expect, it } from 'vitest'
import { activityPhrase } from '../activityPhrase'

describe('activityPhrase', () => {
  it('phrases work as happening rather than finished', () => {
    expect(activityPhrase('Read camera.py')).toBe('Reading camera.py')
    expect(activityPhrase('Edit ui.py')).toBe('Editing ui.py')
    expect(activityPhrase('Search "orbital mechanics"')).toBe('Searching "orbital mechanics"')
    expect(activityPhrase('List changes')).toBe('Listing changes')
  })

  /** A trailing colon is the title's punctuation, not part of the verb. */
  it('reads through the colon some titles use', () => {
    expect(activityPhrase('Run: npm test')).toBe('Running npm test')
    expect(activityPhrase('Check: types')).toBe('Checking types')
  })

  it('handles a title that is a verb and nothing else', () => {
    expect(activityPhrase('Finish goal')).toBe('Finishing goal')
    expect(activityPhrase('Read')).toBe('Reading')
  })

  /**
   * A directory is noise in a one-line ticker and the tool card below still
   * carries the full path.
   */
  it('names the file rather than its whole path', () => {
    expect(activityPhrase('Read src/renderer/features/chat/MessageBubble.tsx')).toBe(
      'Reading MessageBubble.tsx'
    )
    expect(activityPhrase('Read src/game/main.py lines 10-40')).toBe('Reading main.py lines 10-40')
  })

  /**
   * The one place shortening a path would be a lie: it would name a command
   * nobody ran.
   */
  it('never rewrites a command, even one containing a path', () => {
    expect(activityPhrase('Run: python src/game/main.py')).toBe('Running python src/game/main.py')
  })

  it('leaves a directory listing its subject', () => {
    expect(activityPhrase('List src/main')).toBe('Listing src/main')
  })

  /**
   * Inventing grammar for an unrecognised title would be worse than showing the
   * title, so an unknown opening word declines to answer.
   */
  it('says nothing rather than guessing at a title it cannot parse', () => {
    expect(activityPhrase('Git status')).toBeNull()
    expect(activityPhrase('Semantic search "orbit"')).toBeNull()
    expect(activityPhrase('Info package.json')).toBeNull()
    expect(activityPhrase('')).toBeNull()
    expect(activityPhrase('42 things')).toBeNull()
  })

  it('keeps the phrase to one line', () => {
    const phrase = activityPhrase('Run: python -m pytest tests/ -k "integration and slow" -vv')
    expect(phrase!.length).toBeLessThanOrEqual(56)
    expect(phrase).toContain('…')
  })
})
