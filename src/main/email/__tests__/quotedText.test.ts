import { describe, expect, it } from 'vitest'
import { stripQuotedReply } from '../quotedText'

describe('stripQuotedReply', () => {
  it('cuts a Gmail attribution line and everything under it', () => {
    // The shape that caused the original bug: the new sentence, then a wrapped
    // "On ... wrote:" line, then the app's own outgoing mail quoted back.
    const body = [
      "That's great glad to hear emails being worked on. Do you think",
      'tomorrow at 12pm you can give me a new update?',
      '',
      'On Fri, Jul 24, 2026, 10:57 PM <invictioncraft@gmail.com> wrote:',
      '',
      '> Hi Gabriel,',
      '>',
      "> Thanks for checking in. We're a few weeks out from release."
    ].join('\n')

    expect(stripQuotedReply(body)).toBe(
      "That's great glad to hear emails being worked on. Do you think\ntomorrow at 12pm you can give me a new update?"
    )
  })

  it('handles an attribution line that wraps mid-sentence', () => {
    const body = [
      'Sounds good.',
      '',
      'On Fri, Jul 24, 2026 at 10:57 PM Gabriel Shaw',
      '<gabeshaw4christ@gmail.com> wrote:',
      '> the original'
    ].join('\n')

    expect(stripQuotedReply(body)).toBe('Sounds good.')
  })

  it('cuts Outlook separators', () => {
    expect(stripQuotedReply('My answer.\n\n-----Original Message-----\nFrom: someone')).toBe(
      'My answer.'
    )
    expect(stripQuotedReply(`My answer.\n\n${'_'.repeat(32)}\nFrom: someone`)).toBe('My answer.')
  })

  it('cuts an inline Outlook header block', () => {
    const body = [
      'Answering below.',
      '',
      'From: Gabriel Shaw',
      'Sent: Friday, July 24',
      'To: me'
    ].join('\n')
    expect(stripQuotedReply(body)).toBe('Answering below.')
  })

  it('cuts at the first plain-text quote line when there is no attribution', () => {
    expect(stripQuotedReply('Short reply.\n\n> quoted line\n> another')).toBe('Short reply.')
  })

  it('normalizes CRLF so a Windows-sent reply is cut too', () => {
    expect(stripQuotedReply('Reply.\r\n\r\n> quoted')).toBe('Reply.')
  })

  it('keeps a body it does not recognize completely intact', () => {
    // Losing real content is worse than leaving a quote in, so anything
    // unrecognized passes through — including a non-English attribution.
    const spanish = 'Gracias.\n\nEl 24 jul 2026, Gabriel escribió:\nel original'
    expect(stripQuotedReply(spanish)).toBe(spanish)
  })

  it('does not cut on prose that merely resembles a marker', () => {
    // "wrote:" mid-sentence, and a "From:" with no second header under it.
    expect(stripQuotedReply('He said that on Tuesday he wrote: see the notes.')).toBe(
      'He said that on Tuesday he wrote: see the notes.'
    )
    expect(stripQuotedReply('From: the desk of Gabriel\n\nJust a note.')).toBe(
      'From: the desk of Gabriel\n\nJust a note.'
    )
  })

  it('takes the earliest marker when several appear', () => {
    const body = ['New text.', '> quoted first', '', 'On Mon, someone wrote:', '> more'].join('\n')
    expect(stripQuotedReply(body)).toBe('New text.')
  })

  it('returns an empty string for a body that is nothing but quotes', () => {
    expect(stripQuotedReply('> only quoted text')).toBe('')
    expect(stripQuotedReply('')).toBe('')
  })
})
