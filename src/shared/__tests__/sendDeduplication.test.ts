import { describe, expect, it } from 'vitest'
import {
  DUPLICATE_SEND_WINDOW_MS,
  describeDuplicateSend,
  findDuplicateSend,
  sendFingerprint,
  type SentEmailRecord
} from '../sendDeduplication'

/**
 * The duplicate this guards against was real: a model denied a send it had
 * made, sent again, and two identical emails arrived a minute apart. The
 * approval card is the place the human could have caught it, and it said only
 * "send this email?".
 *
 * The tests split into two halves. What must match, so a retyped or reordered
 * repeat is still caught — a model reproducing a message rarely reproduces the
 * whitespace. And what must not, because a warning on a genuinely different
 * email trains people to click through warnings.
 */
const NOW = new Date('2026-09-02T18:00:00Z').getTime()
const MINUTE = 60_000

const base = {
  to: ['someone@example.com'],
  subject: 'Anodex send test',
  body: 'This is an automated delivery test from Anodex.'
}

describe('sendFingerprint', () => {
  it('matches an identical message', () => {
    expect(sendFingerprint(base)).toBe(sendFingerprint({ ...base }))
  })

  it('ignores recipient order', () => {
    const a = sendFingerprint({ ...base, to: ['a@example.com', 'b@example.com'] })
    const b = sendFingerprint({ ...base, to: ['b@example.com', 'a@example.com'] })
    expect(a).toBe(b)
  })

  it('ignores address case and surrounding spaces', () => {
    expect(sendFingerprint({ ...base, to: ['  Someone@Example.COM '] })).toBe(sendFingerprint(base))
  })

  it('ignores whitespace differences in the body', () => {
    // The case that matters: a model re-composing the same message almost
    // never reproduces the original line breaks.
    expect(
      sendFingerprint({ ...base, body: 'This is an automated\n\n  delivery test from Anodex.' })
    ).toBe(sendFingerprint(base))
  })

  it('distinguishes a different recipient', () => {
    expect(sendFingerprint({ ...base, to: ['other@example.com'] })).not.toBe(sendFingerprint(base))
  })

  it('distinguishes a different subject', () => {
    expect(sendFingerprint({ ...base, subject: 'Something else' })).not.toBe(sendFingerprint(base))
  })

  it('distinguishes a different body', () => {
    expect(sendFingerprint({ ...base, body: 'Different content entirely.' })).not.toBe(
      sendFingerprint(base)
    )
  })

  it('does not collapse two recipients into one', () => {
    expect(sendFingerprint({ ...base, to: ['a@example.com', 'b@example.com'] })).not.toBe(
      sendFingerprint({ ...base, to: ['a@example.com'] })
    )
  })
})

describe('findDuplicateSend', () => {
  const fingerprint = sendFingerprint(base)
  const record = (at: number): SentEmailRecord => ({
    fingerprint,
    at,
    to: base.to,
    subject: base.subject
  })

  it('finds a matching send inside the window', () => {
    expect(findDuplicateSend([record(NOW - 4 * MINUTE)], fingerprint, NOW)?.at).toBe(
      NOW - 4 * MINUTE
    )
  })

  it('ignores one outside the window', () => {
    expect(
      findDuplicateSend([record(NOW - DUPLICATE_SEND_WINDOW_MS - 1)], fingerprint, NOW)
    ).toBeNull()
  })

  it('ignores a different message', () => {
    expect(findDuplicateSend([record(NOW - MINUTE)], 'a different fingerprint', NOW)).toBeNull()
  })

  it('returns the most recent match, not the first', () => {
    // The warning quotes the closest one; "four minutes ago" beats "twenty-nine".
    const found = findDuplicateSend(
      [record(NOW - 25 * MINUTE), record(NOW - 4 * MINUTE)],
      fingerprint,
      NOW
    )
    expect(found?.at).toBe(NOW - 4 * MINUTE)
  })

  it('returns null for an empty history', () => {
    expect(findDuplicateSend([], fingerprint, NOW)).toBeNull()
  })
})

describe('describeDuplicateSend', () => {
  const record: SentEmailRecord = {
    fingerprint: 'x',
    at: NOW - 4 * MINUTE,
    to: base.to,
    subject: base.subject
  }

  it('leads with the fact and names the consequence', () => {
    const text = describeDuplicateSend(record, NOW)
    expect(text).toContain('ALREADY SENT')
    expect(text).toContain('4 minutes ago')
    expect(text).toContain('second copy')
  })

  it('tells the reader the assistant may have denied it', () => {
    // The specific trap: the model says "I never sent it" and the person
    // approves on that basis. The card has to contradict it.
    expect(describeDuplicateSend(record, NOW)).toMatch(/mistaken/i)
  })

  it('reads correctly for one minute and for under a minute', () => {
    expect(describeDuplicateSend({ ...record, at: NOW - MINUTE }, NOW)).toContain('1 minute ago')
    expect(describeDuplicateSend({ ...record, at: NOW - 5_000 }, NOW)).toContain(
      'less than a minute ago'
    )
  })
})
