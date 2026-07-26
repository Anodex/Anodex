import { describe, expect, it } from 'vitest'
import {
  brandLabel,
  cleanSnippet,
  formatThreadDate,
  identityKey,
  parseSender,
  senderInitial,
  senderTone
} from '../threadRow'

describe('parseSender', () => {
  it('splits a display name from its address', () => {
    expect(parseSender('Spotify <no-reply@spotify.com>')).toEqual({
      name: 'Spotify',
      address: 'no-reply@spotify.com'
    })
  })

  it('unquotes a quoted display name', () => {
    expect(parseSender('"Claude Team" <no-reply@email.claude.com>').name).toBe('Claude Team')
  })

  it('falls back to the address when there is no display name', () => {
    expect(parseSender('<no-reply@spotify.com>').name).toBe('no-reply@spotify.com')
    expect(parseSender('no-reply@spotify.com').name).toBe('no-reply@spotify.com')
  })
})

describe('brandLabel', () => {
  it('reduces a sending subdomain to the brand behind it', () => {
    expect(brandLabel('no-reply@email.claude.com')).toBe('claude')
    expect(brandLabel('support@claude.com')).toBe('claude')
    expect(brandLabel('no-reply@news.meshy.ai')).toBe('meshy')
  })

  it('drops a registry second level', () => {
    expect(brandLabel('hello@acme.co.uk')).toBe('acme')
    expect(brandLabel('hello@acme.com.au')).toBe('acme')
  })

  it('keeps a sending word that is the brand itself', () => {
    expect(brandLabel('editor@news.com')).toBe('news')
  })
})

describe('identityKey', () => {
  it('keys a company on its brand, so every address there matches', () => {
    expect(identityKey('no-reply@email.claude.com')).toBe(identityKey('support@claude.com'))
  })

  it('keys a consumer mailbox on the whole address', () => {
    // Two people at gmail.com are two people, not one "gmail".
    expect(identityKey('ada@gmail.com')).not.toBe(identityKey('grace@gmail.com'))
  })
})

describe('senderTone', () => {
  it('is stable for the same sender and shared across a brand', () => {
    expect(senderTone('no-reply@spotify.com')).toBe(senderTone('no-reply@spotify.com'))
    expect(senderTone('no-reply@email.claude.com')).toBe(senderTone('billing@claude.com'))
  })

  it('only ever returns a point on the logo ramp', () => {
    // Never a status hue: an avatar means "same sender", and green or amber
    // squares in an inbox read as a verdict on the mail.
    const tones = new Set(
      ['a@a.com', 'b@b.com', 'c@c.io', 'd@d.dev', 'e@e.net', 'f@f.org', 'g@g.co'].map(senderTone)
    )
    for (const tone of tones) {
      expect(['cyan', 'azure', 'blue', 'indigo', 'violet']).toContain(tone)
    }
  })
})

describe('senderInitial', () => {
  it('takes the display name where there is one', () => {
    expect(senderInitial(parseSender('Claude Team <no-reply@email.claude.com>'))).toBe('C')
  })

  it('takes the brand, not the local part, for a bare company address', () => {
    // `no-reply@email.claude.com` must not show an N or an E.
    expect(senderInitial(parseSender('no-reply@email.claude.com'))).toBe('C')
  })

  it('takes the local part for a bare consumer address', () => {
    expect(senderInitial(parseSender('grace@gmail.com'))).toBe('G')
  })

  it('survives a sender with nothing usable in it', () => {
    expect(senderInitial(parseSender(''))).toBe('?')
  })
})

describe('cleanSnippet', () => {
  it('strips a stylesheet the provider cut the message off inside', () => {
    // Exactly what the Meshy row rendered before this existed.
    const raw =
      '96 * { box-sizing: border-box; } body { margin: 0; padding: 0; } ' +
      'a[x-apple-data-detectors] { color: inherit !important; } #MessageViewBody a { color: inh'
    expect(cleanSnippet(raw)).toBe('')
  })

  it('drops tracking URLs and the punctuation left holding them', () => {
    const raw =
      'Your Spotify just got better. LISTEN NOW ( https://open.spotify.com ) ' +
      'Spotify https://open.spotify.com ----'
    expect(cleanSnippet(raw)).toBe('Your Spotify just got better. LISTEN NOW Spotify')
  })

  it('removes tags and decodes entities', () => {
    expect(cleanSnippet('<p>Ada &amp; Grace&nbsp;shipped it</p>')).toBe('Ada & Grace shipped it')
    expect(cleanSnippet('<style>p{color:red}</style>Real text')).toBe('Real text')
  })

  it('removes the zero-width padding bulk senders pad with', () => {
    expect(cleanSnippet('Deal​‌‍ inside﻿')).toBe('Deal inside')
  })

  it('cuts long text at a sentence boundary', () => {
    const raw = `${'a'.repeat(90)}. ${'b'.repeat(200)}`
    const result = cleanSnippet(raw)
    expect(result).toBe(`${'a'.repeat(90)}.`)
  })

  it('cuts at a word break when no sentence ends nearby', () => {
    const result = cleanSnippet(`${'word '.repeat(60)}`)
    expect(result.length).toBeLessThanOrEqual(161)
    expect(result.endsWith('…')).toBe(true)
    expect(result).not.toContain('wor…')
  })

  it('leaves an ordinary snippet alone', () => {
    expect(cleanSnippet('Claim your one-time usage credit before August 2.')).toBe(
      'Claim your one-time usage credit before August 2.'
    )
  })

  it('handles an empty snippet', () => {
    expect(cleanSnippet('')).toBe('')
  })
})

describe('formatThreadDate', () => {
  // A fixed local-time reference so the assertions do not depend on the day
  // the suite happens to run.
  const now = new Date(2026, 6, 25, 15, 0).getTime()
  const at = (...args: [number, number, number, number?, number?]): number =>
    new Date(...(args as [number, number, number])).getTime()

  it('shows a time for today', () => {
    expect(formatThreadDate(at(2026, 6, 25, 16, 12), now, 'en-US')).toBe('4:12 PM')
  })

  it('shows a weekday inside the last week', () => {
    expect(formatThreadDate(at(2026, 6, 21), now, 'en-US')).toBe('Tue')
  })

  it('shows a weekday for yesterday even when only minutes ago', () => {
    // 11pm yesterday is under 24 hours back but is not today.
    expect(formatThreadDate(at(2026, 6, 24, 23, 30), now, 'en-US')).toBe('Fri')
  })

  it('shows a month and day earlier in the same year', () => {
    expect(formatThreadDate(at(2026, 6, 15), now, 'en-US')).toBe('Jul 15')
  })

  it('shows a month and year for anything older', () => {
    expect(formatThreadDate(at(2025, 6, 15), now, 'en-US')).toBe('Jul 2025')
  })

  it('returns nothing for an unusable timestamp', () => {
    expect(formatThreadDate(Number.NaN, now, 'en-US')).toBe('')
  })
})
