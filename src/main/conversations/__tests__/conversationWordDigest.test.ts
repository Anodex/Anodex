import { describe, expect, it } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import { searchWords } from '@shared/transcriptSearch'
import { couldMatch, wordDigestOf } from '../conversationWordDigest'

function conversationSaying(
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
): Conversation {
  return {
    id: 'chat-1',
    projectId: null,
    title: 'Test chat',
    createdAt: 1,
    updatedAt: 1,
    messages: messages.map((message, index) => ({
      id: `m${index}`,
      role: message.role,
      content: message.content,
      createdAt: 1
    }))
  }
}

const digestFor = (...contents: string[]): string =>
  wordDigestOf(conversationSaying(contents.map((content) => ({ role: 'user', content }))))

describe('a conversation’s word digest', () => {
  it('keeps each word once, whichever message said it', () => {
    const digest = digestFor('crash report', 'another crash')

    expect(digest).toBe(' crash report another ')
  })

  it('holds only what a search would score: prose from the two people talking', () => {
    const digest = wordDigestOf(
      conversationSaying([
        { role: 'user', content: 'marzipan' },
        { role: 'assistant', content: 'pistachio' },
        { role: 'system', content: 'saffron' },
        { role: 'user', content: '   ' }
      ])
    )

    expect(digest).toContain(' marzipan ')
    expect(digest).toContain(' pistachio ')
    expect(digest).not.toContain('saffron')
  })
})

describe('whether a chat is worth opening', () => {
  it('needs the word itself when that is the whole query', () => {
    const digest = digestFor('the marzipan recipe')

    expect(couldMatch(digest, searchWords('marzipan'))).toBe(true)
    expect(couldMatch(digest, searchWords('pistachio'))).toBe(false)
  })

  it('needs two of them when the query is longer, as a score of two does', () => {
    const digest = digestFor('the marzipan recipe')

    expect(couldMatch(digest, searchWords('marzipan pistachio'))).toBe(false)
    expect(couldMatch(digest, searchWords('marzipan recipe'))).toBe(true)
  })

  it('opens a chat that only ever said the longer word', () => {
    // Searching for "checkpoint" surfaces a chat that said "checkpoints": the
    // verbatim-phrase part of the score is a substring match, so a whole-word test
    // here would skip a chat the search does find.
    expect(couldMatch(digestFor('marzipanning'), searchWords('marzipan'))).toBe(true)
  })

  it('refuses a query with nothing in it to match on', () => {
    expect(couldMatch(digestFor('anything'), searchWords('is it?'))).toBe(false)
  })
})
