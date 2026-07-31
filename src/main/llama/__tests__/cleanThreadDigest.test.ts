import { describe, expect, it } from 'vitest'
import { cleanThreadDigest } from '../LlamaService'

/**
 * The digest that ends up on an inbox row. Everything here that returns null
 * leaves the row on its provider snippet, which is what it showed before
 * digests existed — so rejecting is always safe, and accepting narration is
 * not.
 */
describe('cleanThreadDigest', () => {
  it('keeps a plain one-sentence answer', () => {
    expect(cleanThreadDigest('Dana wants the seat count corrected to 48.')).toBe(
      'Dana wants the seat count corrected to 48.'
    )
  })

  it('rejects a reasoning model narrating instead of answering', () => {
    // Observed directly with a local Qwen3.6: every row in the inbox carried
    // this identical sentence, because the narration says nothing about the
    // thread it was supposed to be about.
    expect(cleanThreadDigest("Here's a thinking process: 1. Identify the sender.")).toBeNull()
    expect(cleanThreadDigest('Okay, let me look at what this thread is asking.')).toBeNull()
    expect(cleanThreadDigest('The user wants a one-sentence summary of this email.')).toBeNull()
  })

  it('keeps a concrete indirect question despite its user-focused wording', () => {
    // This is a genuine digest emitted by Qwen3.6. It used to be accidentally
    // caught by the reasoning guard simply because it begins "The user asks".
    expect(cleanThreadDigest('The user asks if they are banned from Reddit.')).toBe(
      'The user asks if they are banned from Reddit.'
    )
  })

  it('drops a tagged reasoning block and keeps the answer after it', () => {
    expect(
      cleanThreadDigest(
        '<think>They want a summary, so I should…</think>\nSpotify is advertising free on-demand playback.'
      )
    ).toBe('Spotify is advertising free on-demand playback.')
  })

  it('returns nothing when an unterminated reasoning block swallows the reply', () => {
    // What a 96-token budget does to a model that thinks first: it never
    // reaches the answer.
    expect(cleanThreadDigest('<think>Let me work through what this thread is')).toBeNull()
  })

  it('reaches the answer on a later line when narration comes first', () => {
    expect(
      cleanThreadDigest('Okay, here goes.\nGoogle flagged a new app password on your account.')
    ).toBe('Google flagged a new app password on your account.')
  })

  it('takes only the first sentence', () => {
    expect(cleanThreadDigest('Reddit sent a digest of new posts. Nothing needs a reply.')).toBe(
      'Reddit sent a digest of new posts.'
    )
  })

  it('does not treat an abbreviated name as the end of the sentence', () => {
    expect(cleanThreadDigest('J. Okafor asks for the invoice to be reissued.')).toBe(
      'J. Okafor asks for the invoice to be reissued.'
    )
  })

  it('strips wrapping quotes the prompt asked it not to add', () => {
    expect(cleanThreadDigest('“Meshy shipped a new retopology endpoint.”')).toBe(
      'Meshy shipped a new retopology endpoint.'
    )
  })

  it('rejects a fragment too short to be about anything', () => {
    expect(cleanThreadDigest('1.')).toBeNull()
    expect(cleanThreadDigest('Sure!')).toBeNull()
    expect(cleanThreadDigest('')).toBeNull()
    expect(cleanThreadDigest('   \n  ')).toBeNull()
  })

  it('truncates something far past a sentence', () => {
    const long = `${'Dana keeps writing and writing '.repeat(20)}stop`
    const result = cleanThreadDigest(long)
    expect(result?.length).toBeLessThanOrEqual(201)
    expect(result?.endsWith('…')).toBe(true)
  })
})
