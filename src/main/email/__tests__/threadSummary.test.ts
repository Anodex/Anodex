import { describe, expect, it } from 'vitest'
import { MAX_THREAD_PREVIEW, dedupeParticipants, threadPreview } from '../threadSummary'

describe('threadPreview', () => {
  it('shows only the new words of a reply', () => {
    // Reproduces the observed summary: the provider snippet led with the new
    // sentence but ran straight into the quoted copy of our own outgoing mail
    // and was cut mid-word at "Hi Gabri".
    const message = {
      body: [
        "That's great glad to hear emails being worked on. Do you think",
        'tomorrow at 12pm you can give me a new update?',
        '',
        'On Fri, Jul 24, 2026, 10:57 PM <invictioncraft@gmail.com> wrote:',
        '',
        '> Hi Gabriel,',
        '>',
        "> Thanks for checking in. We're a few weeks out from release."
      ].join('\n'),
      snippet: "That's great glad to hear emails being worked on. On Fri, Jul 24 ... Hi Gabri"
    }

    const preview = threadPreview(message)

    expect(preview).toContain('tomorrow at 12pm')
    expect(preview).not.toContain('wrote:')
    expect(preview).not.toContain('Hi Gabriel')
  })

  it('prefers the body over the snippet, since the snippet carries quotes', () => {
    const preview = threadPreview({
      body: 'The full new message.',
      snippet: 'The full new message. On Mon someone wrote: > old stuff'
    })
    expect(preview).toBe('The full new message.')
  })

  it('falls back to the snippet when the body is empty', () => {
    // Metadata-only sync: a snippet is all the provider gave us.
    expect(threadPreview({ body: '', snippet: 'Server-side preview text.' })).toBe(
      'Server-side preview text.'
    )
  })

  it('leaves a flattened snippet alone, quotes and all', () => {
    // Documents a real limit rather than a wish: the quote markers are anchored
    // to line starts so they cannot cut mid-sentence prose, and a provider
    // snippet is usually one collapsed line. This is why the body is preferred
    // whenever there is one — the snippet path cannot be cleaned reliably.
    expect(threadPreview({ body: '', snippet: 'New words. > quoted tail' })).toBe(
      'New words. > quoted tail'
    )
  })

  it('does de-quote a snippet that kept its line breaks', () => {
    expect(threadPreview({ body: '', snippet: 'New words.\n> quoted tail' })).toBe('New words.')
  })

  it('falls back to the snippet when the body is nothing but quoted text', () => {
    expect(threadPreview({ body: '> only quoted', snippet: 'A snippet.' })).toBe('A snippet.')
  })

  it('truncates with a marker rather than cutting silently', () => {
    const preview = threadPreview({ body: 'x'.repeat(MAX_THREAD_PREVIEW + 50), snippet: '' })
    expect(preview).toHaveLength(MAX_THREAD_PREVIEW + 3)
    expect(preview.endsWith('...')).toBe(true)
  })

  it('returns empty when there is nothing to show', () => {
    expect(threadPreview({ body: '', snippet: '' })).toBe('')
  })
})

describe('dedupeParticipants', () => {
  it('collapses the same mailbox spelled two different ways', () => {
    // The exact pair a real summary printed side by side.
    expect(
      dedupeParticipants([
        'Invictioncraft@gmail.com',
        'Invictioncraft@gmail.com <invictioncraft@gmail.com>'
      ])
    ).toEqual(['Invictioncraft@gmail.com'])
  })

  it('keeps the first spelling, so a display name survives', () => {
    expect(dedupeParticipants(['"Gabriel Shaw" <gabe@example.com>', 'gabe@example.com'])).toEqual([
      '"Gabriel Shaw" <gabe@example.com>'
    ])
  })

  it('matches case-insensitively on the address', () => {
    expect(dedupeParticipants(['Gabe@Example.com', 'gabe@example.com'])).toEqual([
      'Gabe@Example.com'
    ])
  })

  it('keeps genuinely different people', () => {
    expect(dedupeParticipants(['a@example.com', 'b@example.com'])).toEqual([
      'a@example.com',
      'b@example.com'
    ])
  })

  it('drops blank entries', () => {
    expect(dedupeParticipants(['', '   ', 'a@example.com'])).toEqual(['a@example.com'])
  })
})
