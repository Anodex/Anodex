import { describe, expect, it } from 'vitest'
import {
  decodeThreadId,
  encodeThreadId,
  normalizeSubject,
  subjectSearchTerm
} from '../ImapSmtpAdapter'

/**
 * Thread identity for IMAP, which has no thread primitive of its own.
 *
 * Both properties tested here are load-bearing for destructive operations:
 * `applyFlag`/`move` resolve a thread id to the set of messages they act on, so
 * a thread id that matches too much moves mail the user never selected.
 */

describe('normalizeSubject', () => {
  it('strips a single reply prefix', () => {
    expect(normalizeSubject('Re: Quarterly report')).toBe('Quarterly report')
  })

  it('strips stacked prefixes, which clients accumulate on a long exchange', () => {
    // Stripping only the outermost left "Re: Quarterly report", which encodes
    // to a different thread id than "Quarterly report" — so the same
    // conversation fragmented into separate threads as it grew.
    expect(normalizeSubject('Re: Re: Quarterly report')).toBe('Quarterly report')
    expect(normalizeSubject('Fwd: Re: Quarterly report')).toBe('Quarterly report')
    expect(normalizeSubject('RE: FW: Quarterly report')).toBe('Quarterly report')
    expect(normalizeSubject('Re:Re:Quarterly report')).toBe('Quarterly report')
  })

  it('leaves a subject that merely starts with those letters alone', () => {
    expect(normalizeSubject('Renewal due')).toBe('Renewal due')
    expect(normalizeSubject('Review: the plan')).toBe('Review: the plan')
  })

  it('collapses whitespace', () => {
    expect(normalizeSubject('  Re:   Quarterly    report ')).toBe('Quarterly report')
  })
})

describe('encodeThreadId', () => {
  it('gives every reply in one exchange the same thread id', () => {
    const original = encodeThreadId('Quarterly report', 'INBOX', 1)
    const reply = encodeThreadId('Re: Quarterly report', 'INBOX', 2)
    const later = encodeThreadId('Re: Re: Quarterly report', 'INBOX', 3)

    expect(reply).toBe(original)
    expect(later).toBe(original)
  })

  it('gives a subject-less message a thread of its own', () => {
    // An empty subject cannot key a subject match: IMAP SEARCH HEADER is a
    // substring test and every subject contains the empty string, so this used
    // to produce a thread that resolved to the entire mailbox.
    const first = encodeThreadId('', 'INBOX', 1)
    const second = encodeThreadId('   ', 'INBOX', 2)

    expect(first.startsWith('msg.')).toBe(true)
    expect(second.startsWith('msg.')).toBe(true)
    expect(first).not.toBe(second)
  })

  it('does not confuse a subject-less message with one whose subject is a prefix', () => {
    // "Re:" normalizes to nothing, so it is subject-less too.
    expect(encodeThreadId('Re:', 'INBOX', 1).startsWith('msg.')).toBe(true)
  })
})

describe('decodeThreadId', () => {
  it('round-trips a subject thread', () => {
    const id = encodeThreadId('Quarterly report', 'INBOX', 1)

    expect(decodeThreadId(id)).toEqual({ kind: 'subject', subject: 'Quarterly report' })
  })

  it('round-trips a subject containing non-ASCII', () => {
    const id = encodeThreadId('Réunion trimestrielle — résumé', 'INBOX', 1)

    expect(decodeThreadId(id)).toEqual({
      kind: 'subject',
      subject: 'Réunion trimestrielle — résumé'
    })
  })

  it('resolves a subject-less thread to its single message', () => {
    const id = encodeThreadId('', 'INBOX', 42)
    const key = decodeThreadId(id)

    expect(key.kind).toBe('message')
    if (key.kind !== 'message') throw new Error('expected a message thread')
    expect(key.messageId).toBe(id.slice('msg.'.length))
  })

  it('rejects a legacy empty-subject id rather than sweeping the mailbox', () => {
    // Ids of this shape were minted before subject-less messages got their own
    // threads, and can still be persisted on a chat linked to an email thread.
    expect(() => decodeThreadId('subj.')).toThrow(/not a valid IMAP thread id/)
  })

  it('rejects ids from another provider, and malformed message threads', () => {
    expect(() => decodeThreadId('18f2c1a9b')).toThrow(/not a valid IMAP thread id/)
    expect(() => decodeThreadId('msg.not-a-real-id')).toThrow(/not a valid IMAP message id/)
  })
})

/**
 * What the server is asked for when a thread is opened.
 *
 * `HEADER SUBJECT` is a substring test, so any stretch of the subject is a legal
 * query and the adapter matches exactly afterwards. The term exists to route
 * around servers that disagree with us about punctuation: Gmail answered nothing
 * at all for two subjects in the same mailbox, both ending in a question mark,
 * while returning subjects containing apostrophes, commas and an em dash. Every
 * message in those conversations was unreachable from both the computer and the
 * phone, and the screen said nothing about why.
 */
describe('subjectSearchTerm', () => {
  it('is always a substring of the subject', () => {
    // The property the whole approach rests on. A server entitled to read
    // `HEADER SUBJECT` strictly must still match what we send.
    for (const subject of [
      "This intense exchange with Trump's surgeon general pick is going viral. Why?",
      '"Anyone else dealing with this?"',
      "The Kennedy Center is 'temporarily' closed — and a judge has questions",
      'Deadly Amazon cargo plane crash at Miami airport investigated by FAA, NTSB',
      'Start a project to give each idea a home'
    ]) {
      expect(subject).toContain(subjectSearchTerm(subject))
    }
  })

  it('drops the punctuation a search may mishandle', () => {
    // The two subjects that went unopenable in a real mailbox.
    expect(subjectSearchTerm('"Anyone else dealing with this?"')).toBe(
      'Anyone else dealing with this'
    )
    expect(
      subjectSearchTerm(
        "This intense exchange with Trump's surgeon general pick is going viral. Why?"
      )
    ).toBe('s surgeon general pick is going viral')
  })

  it('leaves an ordinary subject whole', () => {
    // The common case. A subject with nothing awkward in it is asked for
    // exactly, which is both the narrowest query and what happened before.
    expect(subjectSearchTerm('Start a project to give each idea a home')).toBe(
      'Start a project to give each idea a home'
    )
    expect(subjectSearchTerm('4 new image styles to try')).toBe('4 new image styles to try')
  })

  it('keeps hyphens and underscores, which no server minds', () => {
    expect(subjectSearchTerm('mail-in voting restrictions blocked')).toBe(
      'mail-in voting restrictions blocked'
    )
    expect(subjectSearchTerm('anodex_ai, see detesa83 and more in your feed')).toBe(
      'see detesa83 and more in your feed'
    )
  })

  it('falls back to the whole subject when nothing long enough survives', () => {
    // A four-letter term would match half the mailbox, and each match costs a
    // full message fetch. Asking for the awkward subject is no worse than what
    // every subject did before this existed.
    expect(subjectSearchTerm('Re: ?!')).toBe('Re: ?!')
    expect(subjectSearchTerm('$$$ !!! ???')).toBe('$$$ !!! ???')
  })

  it('works in a script with no Latin letters', () => {
    // `\p{L}` rather than `a-z`: a subject in Greek or Japanese is a subject,
    // and reducing one to its punctuation would make every such thread fall
    // back to the query that fails.
    expect(subjectSearchTerm('Συνάντηση την Τρίτη;')).toBe('Συνάντηση την Τρίτη')
  })
})
