import { describe, expect, it } from 'vitest'
import type { EmailMessage } from '@shared/email.types'
import {
  formatMessageTime,
  formatThreadDateSpan,
  newestThreadMessage,
  orderThreadMessagesNewestFirst,
  threadParticipants
} from '../threadMessages'

function message(
  id: string,
  date: number,
  from = 'Gabriel Shaw <gabeshaw4christ@gmail.com>'
): EmailMessage {
  return {
    id,
    date,
    threadId: 'thread-1',
    provider: 'gmail',
    accountId: 'account-1',
    subject: 'Anodex update',
    from,
    to: ['invictioncraft@gmail.com'],
    cc: [],
    bcc: [],
    snippet: '',
    body: '',
    attachments: []
  }
}

describe('orderThreadMessagesNewestFirst', () => {
  it('puts the newest response at the top without mutating the provider result', () => {
    const messages = [message('middle', 200), message('oldest', 100), message('newest', 300)]

    expect(orderThreadMessagesNewestFirst(messages).map((item) => item.id)).toEqual([
      'newest',
      'middle',
      'oldest'
    ])
    expect(messages.map((item) => item.id)).toEqual(['middle', 'oldest', 'newest'])
  })

  it('keeps unusable dates below readable messages', () => {
    expect(
      orderThreadMessagesNewestFirst([message('unknown', Number.NaN), message('dated', 100)]).map(
        (item) => item.id
      )
    ).toEqual(['dated', 'unknown'])
  })

  it('uses provider chronology to break equal timestamp ties', () => {
    expect(
      orderThreadMessagesNewestFirst([message('first', 100), message('second', 100)]).map(
        (item) => item.id
      )
    ).toEqual(['second', 'first'])
  })
})

describe('newestThreadMessage', () => {
  it('finds the reply target independently of provider ordering', () => {
    expect(
      newestThreadMessage([message('newest', 300), message('oldest', 100), message('middle', 200)])
        ?.id
    ).toBe('newest')
  })

  it('returns null for an empty thread', () => {
    expect(newestThreadMessage([])).toBeNull()
  })
})

describe('threadParticipants', () => {
  const GABE = 'Gabriel Shaw <gabeshaw4christ@gmail.com>'
  const SUPPORT = 'Namecheap Support <support@namecheap.com>'

  it('lists each distinct speaker once, newest first', () => {
    expect(
      threadParticipants([
        message('a', 100, GABE),
        message('b', 200, SUPPORT),
        message('c', 300, GABE)
      ]).map((sender) => sender.name)
    ).toEqual(['Gabriel Shaw', 'Namecheap Support'])
  })

  it('treats two addresses at one company as one participant', () => {
    // Same person, same brand — one face in the header, not two.
    expect(
      threadParticipants([
        message('a', 100, 'Support <support@claude.com>'),
        message('b', 200, 'Support <billing@email.claude.com>')
      ])
    ).toHaveLength(1)
  })

  it('handles an empty thread', () => {
    expect(threadParticipants([])).toEqual([])
  })
})

describe('formatMessageTime', () => {
  const now = new Date(2026, 6, 25, 15, 0).getTime()
  const at = (...parts: [number, number, number, number, number]): number =>
    new Date(...parts).getTime()

  it('names today rather than dating it', () => {
    expect(formatMessageTime(at(2026, 6, 25, 14, 40), now, 'en-US')).toBe('Today 2:40 PM')
  })

  it('uses a weekday inside the last week', () => {
    expect(formatMessageTime(at(2026, 6, 24, 13, 2), now, 'en-US')).toBe('Fri 1:02 PM')
  })

  it('does not call 11pm yesterday "today"', () => {
    // Under 24 hours back, but a different calendar day.
    expect(formatMessageTime(at(2026, 6, 24, 23, 30), now, 'en-US')).toBe('Fri 11:30 PM')
  })

  it('drops the year within the current one and keeps it otherwise', () => {
    expect(formatMessageTime(at(2026, 6, 15, 9, 14), now, 'en-US')).toBe('Jul 15, 9:14 AM')
    expect(formatMessageTime(at(2025, 6, 15, 9, 14), now, 'en-US')).toBe('Jul 15, 2025, 9:14 AM')
  })

  it('never shows seconds', () => {
    expect(formatMessageTime(at(2026, 6, 22, 9, 14), now, 'en-US')).not.toMatch(/:\d\d:\d\d/)
  })

  it('returns nothing for an unusable timestamp', () => {
    expect(formatMessageTime(Number.NaN, now, 'en-US')).toBe('')
  })
})

describe('formatThreadDateSpan', () => {
  const now = new Date(2026, 6, 25, 12, 0).getTime()

  it('shows the oldest and newest calendar dates in the current year', () => {
    expect(
      formatThreadDateSpan(
        [
          message('newest', new Date(2026, 6, 25, 12, 0).getTime()),
          message('oldest', new Date(2026, 6, 22, 9, 0).getTime())
        ],
        now,
        'en-US'
      )
    ).toBe('Jul 22 – Jul 25')
  })

  it('shows one label when every message arrived on the same day', () => {
    expect(
      formatThreadDateSpan(
        [
          message('later', new Date(2026, 6, 25, 12, 0).getTime()),
          message('earlier', new Date(2026, 6, 25, 9, 0).getTime())
        ],
        now,
        'en-US'
      )
    ).toBe('Jul 25')
  })

  it('includes years for an older or cross-year thread', () => {
    expect(
      formatThreadDateSpan(
        [
          message('newest', new Date(2025, 0, 2, 12, 0).getTime()),
          message('oldest', new Date(2024, 11, 31, 9, 0).getTime())
        ],
        now,
        'en-US'
      )
    ).toBe('Dec 31, 2024 – Jan 2, 2025')
  })
})
