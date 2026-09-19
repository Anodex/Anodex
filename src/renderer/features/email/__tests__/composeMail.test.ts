import { describe, expect, it } from 'vitest'
import type { EmailMessage } from '@shared/email.types'
import {
  addressList,
  blankDraft,
  canSend,
  draftPrompt,
  forwardDraft,
  forwardSubject,
  replyDraft,
  replySubject
} from '../composeMail'

/**
 * Writing a message at the computer.
 *
 * Worth testing as pure functions because every one of these is a decision that
 * is wrong in a way nothing on screen would show: a reply-all that mails you
 * back, a subject that accumulates `Re: Re: Re:`, a forward threaded onto a
 * conversation its new recipient has never seen.
 */

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    provider: 'imap',
    accountId: 'a1',
    subject: 'Quarterly report',
    from: 'Ada Lovelace <ada@example.com>',
    to: ['me@example.com', 'Bob <bob@example.com>'],
    cc: ['carol@example.com'],
    bcc: [],
    date: 1_760_000_000_000,
    snippet: '',
    body: 'The numbers are attached.',
    attachments: [],
    ...overrides
  }
}

describe('replyDraft', () => {
  it('answers the sender, and nobody else', () => {
    const draft = replyDraft(message(), false)

    expect(draft.to).toBe('Ada Lovelace <ada@example.com>')
    expect(draft.cc).toBe('')
  })

  it('reply-all keeps everyone except the sender, who is already in To', () => {
    // Leaving them in both is how a reply-all sends somebody two copies.
    const draft = replyDraft(message(), true)

    expect(draft.cc).toBe('me@example.com, Bob <bob@example.com>, carol@example.com')
    expect(draft.cc).not.toContain('ada@example.com')
  })

  it('matches the sender by address, not by the whole From line', () => {
    // `Ada <ada@example.com>` and `ada@example.com` are the same person, and a
    // string comparison says otherwise.
    const draft = replyDraft(
      message({ from: 'Ada Lovelace <ada@example.com>', to: ['ada@example.com'], cc: [] }),
      true
    )

    expect(draft.cc).toBe('')
  })

  it('carries the message it answers, for threading and for the model', () => {
    expect(replyDraft(message(), false).inReplyTo?.id).toBe('m1')
  })
})

describe('forwardDraft', () => {
  it('starts a conversation rather than joining one', () => {
    // A forward goes to somebody who was not in the original. Threading it onto
    // the old conversation files it under a subject they have never seen.
    const draft = forwardDraft(message())

    expect(draft.inReplyTo).toBeNull()
    expect(draft.to).toBe('')
  })

  it('quotes what is being forwarded, since the recipient has not seen it', () => {
    const draft = forwardDraft(message())

    expect(draft.body).toContain('Forwarded message')
    expect(draft.body).toContain('The numbers are attached.')
  })
})

describe('subjects', () => {
  it('prefixes once, however many times it has been round', () => {
    expect(replySubject('Quarterly report')).toBe('Re: Quarterly report')
    expect(replySubject('Re: Quarterly report')).toBe('Re: Quarterly report')
    expect(replySubject('RE: Quarterly report')).toBe('RE: Quarterly report')
    expect(forwardSubject('Quarterly report')).toBe('Fwd: Quarterly report')
    expect(forwardSubject('Fwd: Quarterly report')).toBe('Fwd: Quarterly report')
    expect(forwardSubject('Fw: Quarterly report')).toBe('Fw: Quarterly report')
  })
})

describe('canSend', () => {
  it('wants a recipient, a subject and something to say', () => {
    // Each missing one fails differently: no recipient cannot be sent at all,
    // no subject arrives looking like spam, and an empty body is a message
    // somebody sent by accident.
    expect(canSend(blankDraft())).toBe(false)
    expect(canSend({ ...blankDraft(), to: 'a@b.com' })).toBe(false)
    expect(canSend({ ...blankDraft(), to: 'a@b.com', subject: 'Hi' })).toBe(false)
    expect(canSend({ ...blankDraft(), to: 'a@b.com', subject: 'Hi', body: 'There' })).toBe(true)
  })

  it('does not count whitespace as an answer', () => {
    expect(canSend({ ...blankDraft(), to: ' ', subject: 'Hi', body: 'There' })).toBe(false)
    expect(canSend({ ...blankDraft(), to: 'a@b.com', subject: '  ', body: 'There' })).toBe(false)
    expect(canSend({ ...blankDraft(), to: 'a@b.com', subject: 'Hi', body: '\n ' })).toBe(false)
  })
})

describe('addressList', () => {
  it('forgives the ways people type several addresses', () => {
    expect(addressList('a@b.com, c@d.com')).toEqual(['a@b.com', 'c@d.com'])
    expect(addressList('a@b.com; c@d.com')).toEqual(['a@b.com', 'c@d.com'])
    expect(addressList(' a@b.com ,, ')).toEqual(['a@b.com'])
    expect(addressList('')).toEqual([])
  })
})

describe('draftPrompt', () => {
  it('gives the model the message being answered', () => {
    const prompt = draftPrompt(replyDraft(message(), false), 'Say yes and thank her.')

    expect(prompt).toContain('Write a reply to this email.')
    expect(prompt).toContain('From: Ada Lovelace <ada@example.com>')
    expect(prompt).toContain('The numbers are attached.')
    expect(prompt).toContain('Say yes and thank her.')
  })

  it('asks for the body and nothing around it', () => {
    // Without this the model answers "Sure! Here's a draft:" — which then gets
    // sent, because it is sitting in the body field looking like a message.
    const prompt = draftPrompt(blankDraft(), 'Ask about Tuesday.')

    expect(prompt).toContain('the body of the message and nothing else')
    expect(prompt).toContain('Do not sign it with a name you have not been given.')
  })

  it('does not paste an entire mail chain into the context', () => {
    const long = draftPrompt(
      replyDraft(message({ body: 'x'.repeat(10_000) }), false),
      'Reply briefly.'
    )

    expect(long.length).toBeLessThan(5_000)
  })
})
