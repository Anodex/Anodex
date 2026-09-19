import { describe, expect, it } from 'vitest'
import { err, reasonFor } from '../result'

/**
 * What a person actually reads when something fails.
 *
 * `AnodexError` carries two sentences. `message` is what the handler decided to
 * call it, written before anything had gone wrong, so it is the same words for
 * every cause. `detail` is what actually happened. Forty-eight of the renderer's
 * sixty-two failure notices showed the first and dropped the second, and they
 * all looked like working error messages: grammatical, on the right screen, and
 * describing every possible cause equally.
 */
describe('reasonFor', () => {
  it('keeps the headline and adds the cause', () => {
    expect(
      reasonFor({
        message: 'Could not send email.',
        detail: 'Invalid login: 535 authentication failed'
      })
    ).toBe('Could not send email. Invalid login: 535 authentication failed')
  })

  it('takes the cause alone when there is no headline', () => {
    expect(reasonFor({ message: '', detail: 'No trash mailbox on this account.' })).toBe(
      'No trash mailbox on this account.'
    )
  })

  it('takes the headline alone when there is no cause', () => {
    // The common case, and the one that must not regress into an empty
    // notification body — a blank error is worse than a vague one.
    expect(reasonFor({ message: 'Could not move that.' })).toBe('Could not move that.')
  })

  it('treats a blank detail as no detail', () => {
    // An empty string is a field nobody filled in, not a provider with nothing
    // to say. It must not displace the headline or trail a space behind it.
    expect(reasonFor({ message: 'Could not move that.', detail: '   ' })).toBe(
      'Could not move that.'
    )
  })

  it('does not say the same thing twice', () => {
    // Handlers that pass the caught error as both halves are common, and
    // 'Not connected. Not connected.' reads like a stutter.
    expect(reasonFor({ message: 'Not connected.', detail: 'Not connected.' })).toBe(
      'Not connected.'
    )
  })

  it('does not repeat a cause the headline already contains', () => {
    expect(
      reasonFor({ message: 'Not connected. Reconnect first.', detail: 'Not connected.' })
    ).toBe('Not connected. Reconnect first.')
  })

  it('reads an error straight off a Result', () => {
    // The shape at every call site, so the type has to fit without a cast.
    const result = err('email.send-failed', 'Could not send email.', 'connect ECONNREFUSED')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(reasonFor(result.error)).toBe('Could not send email. Connect ECONNREFUSED')
    }
  })
})
