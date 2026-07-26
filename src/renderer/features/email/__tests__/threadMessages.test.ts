import { describe, expect, it } from 'vitest'
import type { EmailMessage } from '@shared/email.types'
import {
  formatThreadDateSpan,
  newestThreadMessage,
  orderThreadMessagesNewestFirst
} from '../threadMessages'

function message(id: string, date: number): EmailMessage {
  return {
    id,
    date,
    threadId: 'thread-1',
    provider: 'gmail',
    accountId: 'account-1',
    subject: 'Anodex update',
    from: 'Gabriel Shaw <gabeshaw4christ@gmail.com>',
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
