import { describe, expect, it } from 'vitest'
import { withEmailThreadContext } from '../emailThreadContext'

describe('withEmailThreadContext', () => {
  it('leaves an ordinary chat prompt alone', () => {
    expect(withEmailThreadContext('What time is it?', undefined)).toBe('What time is it?')
  })

  it('carries the ids the email tools address messages by', () => {
    const prompt = withEmailThreadContext('Draft a reply agreeing to both.', {
      accountId: 'acct-1',
      threadId: 'thread-9',
      subject: 'Q3 renewal',
      latestMessageId: 'msg-42'
    })

    expect(prompt).toContain('Draft a reply agreeing to both.')
    expect(prompt).toContain('accountId acct-1')
    expect(prompt).toContain('threadId thread-9')
    expect(prompt).toContain('newest messageId msg-42')
    expect(prompt).toContain('Q3 renewal')
  })

  it('omits the message id for a chat linked before one was recorded', () => {
    // Chats linked by an older build have only the account and thread. Naming
    // a message id that isn't there would be worse than leaving it out.
    const prompt = withEmailThreadContext('Summarize this.', {
      accountId: 'acct-1',
      threadId: 'thread-9'
    })

    expect(prompt).toContain('threadId thread-9')
    expect(prompt).not.toContain('messageId')
    expect(prompt).not.toContain('undefined')
  })
})
