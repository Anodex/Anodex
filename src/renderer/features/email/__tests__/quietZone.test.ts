import { describe, expect, it } from 'vitest'
import type { EmailThreadSummary } from '@shared/email.types'
import { describeQuietRun, groupQuietRuns, isBulkThread } from '../quietZone'

let nextId = 0

function thread(from: string, overrides: Partial<EmailThreadSummary> = {}): EmailThreadSummary {
  nextId += 1
  return {
    id: `t${nextId}`,
    latestMessageId: `m${nextId}`,
    provider: 'gmail',
    accountId: 'a1',
    subject: 'Subject',
    from,
    snippet: '',
    updatedAt: 0,
    unread: false,
    starred: false,
    messageCount: 1,
    attachmentCount: 0,
    ...overrides
  }
}

const PERSON = 'Gabe Shaw <gabeshaw4christ@gmail.com>'

describe('isBulkThread', () => {
  it('catches the mailboxes nobody reads replies to', () => {
    for (const from of [
      'Spotify <no-reply@spotify.com>',
      'Claude Team <noreply@claude.com>',
      'X <do-not-reply@x.com>',
      'Y <newsletter@y.com>',
      'Z <notifications@z.com>',
      'Q <updates+weekly@q.com>',
      'R <mailer-daemon@r.com>',
      'S <alerts@s.com>'
    ]) {
      expect(isBulkThread(thread(from)), from).toBe(true)
    }
  })

  it('catches a subdomain a brand only sends from', () => {
    expect(isBulkThread(thread('Meshy <hello@news.meshy.ai>'))).toBe(true)
    expect(isBulkThread(thread('Claude <team@email.claude.com>'))).toBe(true)
  })

  it('leaves people alone', () => {
    for (const from of [
      PERSON,
      'Namecheap Support <support@namecheap.com>',
      'Ada <ada@acme.co.uk>',
      // `newsroom` is not `news`, and a reply to it plausibly reaches someone.
      'Desk <newsroom@paper.com>',
      'Bot <replybot@acme.com>'
    ]) {
      expect(isBulkThread(thread(from)), from).toBe(false)
    }
  })
})

describe('groupQuietRuns', () => {
  it('folds a run that is long enough', () => {
    const items = groupQuietRuns([
      thread(PERSON),
      thread('a <no-reply@a.com>'),
      thread('b <no-reply@b.com>'),
      thread('c <no-reply@c.com>'),
      thread(PERSON)
    ])
    expect(items.map((item) => item.kind)).toEqual(['thread', 'quiet', 'thread'])
    expect(items[1].kind === 'quiet' && items[1].threads).toHaveLength(3)
  })

  it('leaves a run that is too short expanded', () => {
    const items = groupQuietRuns([
      thread(PERSON),
      thread('a <no-reply@a.com>'),
      thread('b <no-reply@b.com>'),
      thread(PERSON)
    ])
    expect(items.map((item) => item.kind)).toEqual(['thread', 'thread', 'thread', 'thread'])
  })

  it('keeps the list in its original order', () => {
    const people = [thread(PERSON), thread(PERSON)]
    const bulk = [
      thread('a <no-reply@a.com>'),
      thread('b <no-reply@b.com>'),
      thread('c <no-reply@c.com>')
    ]
    const items = groupQuietRuns([people[0], ...bulk, people[1]])
    const flattened = items.flatMap((item) =>
      item.kind === 'thread' ? [item.thread.id] : item.threads.map((each) => each.id)
    )
    expect(flattened).toEqual([people[0].id, ...bulk.map((each) => each.id), people[1].id])
  })

  it('folds a run that runs to the end of the list', () => {
    const items = groupQuietRuns([
      thread(PERSON),
      thread('a <no-reply@a.com>'),
      thread('b <no-reply@b.com>'),
      thread('c <no-reply@c.com>')
    ])
    expect(items.map((item) => item.kind)).toEqual(['thread', 'quiet'])
  })

  it('folds a list that is nothing but bulk', () => {
    const items = groupQuietRuns([
      thread('a <no-reply@a.com>'),
      thread('b <no-reply@b.com>'),
      thread('c <no-reply@c.com>')
    ])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('quiet')
  })

  it('gives a run an id that survives a refresh', () => {
    const run = [
      thread('a <no-reply@a.com>'),
      thread('b <no-reply@b.com>'),
      thread('c <no-reply@c.com>')
    ]
    const first = groupQuietRuns(run)
    const again = groupQuietRuns([...run])
    expect(first[0].kind === 'quiet' && first[0].id).toBe(again[0].kind === 'quiet' && again[0].id)
  })

  it('handles an empty list', () => {
    expect(groupQuietRuns([])).toEqual([])
  })
})

describe('describeQuietRun', () => {
  it('counts the unread only when there are some', () => {
    const run = [
      thread('a <no-reply@a.com>', { unread: true }),
      thread('b <no-reply@b.com>'),
      thread('c <no-reply@c.com>')
    ]
    expect(describeQuietRun(run)).toBe('3 newsletters and notifications · 1 unread')
    expect(describeQuietRun(run.slice(1))).toBe('2 newsletters and notifications')
  })
})
