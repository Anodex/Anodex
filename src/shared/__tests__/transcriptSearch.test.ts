import { describe, expect, it } from 'vitest'
import type { Conversation } from '../conversation.types'
import type { ChatMessage } from '../chat.types'
import { searchTranscripts } from '../transcriptSearch'

function message(
  overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content'>
): ChatMessage {
  return { createdAt: 0, ...overrides }
}

function conversation(overrides: Partial<Conversation> & Pick<Conversation, 'id'>): Conversation {
  return {
    projectId: null,
    title: 'Untitled',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('searchTranscripts', () => {
  it('returns nothing for an empty or whitespace-only query', () => {
    const conversations = [
      conversation({
        id: 'c1',
        messages: [message({ id: 'm1', role: 'user', content: 'fix the login redirect bug' })]
      })
    ]
    expect(searchTranscripts(conversations, '')).toEqual([])
    expect(searchTranscripts(conversations, '   ')).toEqual([])
  })

  it('returns nothing when no conversation matches — no recency fallback', () => {
    const conversations = [
      conversation({
        id: 'c1',
        updatedAt: 1000,
        messages: [message({ id: 'm1', role: 'user', content: 'completely unrelated topic' })]
      })
    ]
    expect(searchTranscripts(conversations, 'authentication database migration')).toEqual([])
  })

  it('finds a conversation by lexical overlap with a user message', () => {
    const conversations = [
      conversation({
        id: 'c1',
        title: 'Auth bug',
        messages: [
          message({ id: 'm1', role: 'user', content: 'the login redirect is broken after auth' })
        ]
      })
    ]

    const results = searchTranscripts(conversations, 'login redirect broken')

    expect(results).toHaveLength(1)
    expect(results[0].conversationId).toBe('c1')
    expect(results[0].excerpts[0].messageId).toBe('m1')
    expect(results[0].excerpts[0].role).toBe('user')
  })

  it('ranks an exact-phrase match above a merely word-overlapping one', () => {
    const conversations = [
      conversation({
        id: 'scattered',
        messages: [
          message({
            id: 'm1',
            role: 'user',
            content: 'the redirect broke, and separately login also needs work'
          })
        ]
      }),
      conversation({
        id: 'phrase',
        messages: [
          message({ id: 'm2', role: 'assistant', content: 'fixed: the login redirect is broken' })
        ]
      })
    ]

    const results = searchTranscripts(conversations, 'login redirect is broken')

    expect(results[0].conversationId).toBe('phrase')
  })

  it('excludes the conversation currently being generated', () => {
    const conversations = [
      conversation({
        id: 'current',
        messages: [message({ id: 'm1', role: 'user', content: 'fix the login redirect bug' })]
      }),
      conversation({
        id: 'other',
        messages: [message({ id: 'm2', role: 'user', content: 'fix the login redirect bug too' })]
      })
    ]

    const results = searchTranscripts(conversations, 'login redirect bug', {
      excludeConversationId: 'current'
    })

    expect(results.map((r) => r.conversationId)).toEqual(['other'])
  })

  it('excludes system messages, empty messages, and messages with no lexical match', () => {
    const conversations = [
      conversation({
        id: 'c1',
        messages: [
          message({ id: 'm1', role: 'system', content: 'login redirect login redirect' }),
          message({ id: 'm2', role: 'user', content: '' }),
          message({ id: 'm3', role: 'user', content: 'unrelated' }),
          message({ id: 'm4', role: 'assistant', content: 'the login redirect works now' })
        ]
      })
    ]

    const results = searchTranscripts(conversations, 'login redirect')

    expect(results).toHaveLength(1)
    expect(results[0].excerpts.map((e) => e.messageId)).toEqual(['m4'])
  })

  it('truncates a long excerpt instead of returning the full message', () => {
    const longContent = `login redirect ${'x'.repeat(500)}`
    const conversations = [
      conversation({
        id: 'c1',
        messages: [message({ id: 'm1', role: 'user', content: longContent })]
      })
    ]

    const results = searchTranscripts(conversations, 'login redirect')

    expect(results[0].excerpts[0].text.length).toBeLessThan(longContent.length)
    expect(results[0].excerpts[0].text.endsWith('…')).toBe(true)
  })

  it('caps excerpts per conversation and total results', () => {
    const manyMessages = Array.from({ length: 10 }, (_, i) =>
      message({ id: `m${i}`, role: 'user', content: `login redirect issue number ${i}` })
    )
    const conversations = [
      conversation({ id: 'c1', messages: manyMessages }),
      conversation({
        id: 'c2',
        messages: [message({ id: 'm-c2', role: 'user', content: 'login redirect somewhere else' })]
      }),
      conversation({
        id: 'c3',
        messages: [message({ id: 'm-c3', role: 'user', content: 'login redirect a third time' })]
      }),
      conversation({
        id: 'c4',
        messages: [message({ id: 'm-c4', role: 'user', content: 'login redirect a fourth time' })]
      })
    ]

    const results = searchTranscripts(conversations, 'login redirect', {
      maxExcerptsPerConversation: 2,
      maxResults: 3
    })

    expect(results).toHaveLength(3)
    expect(results[0].excerpts.length).toBeLessThanOrEqual(2)
  })

  it('does not surface a message on a single incidental word overlap', () => {
    const conversations = [
      conversation({
        id: 'c1',
        messages: [
          message({
            id: 'm1',
            role: 'user',
            content: 'the deployment pipeline failed with a timeout error'
          })
        ]
      })
    ]

    // Only "with" overlaps (a common 4+ letter word) — not a real match.
    const results = searchTranscripts(conversations, 'salary negotiation tips with recruiters')

    expect(results).toEqual([])
  })

  it('centers a long excerpt on the match instead of always taking the prefix', () => {
    const filler = 'unrelated padding text '.repeat(20)
    const content = `${filler}the login redirect is broken ${filler}`
    const conversations = [
      conversation({
        id: 'c1',
        messages: [message({ id: 'm1', role: 'user', content })]
      })
    ]

    const results = searchTranscripts(conversations, 'login redirect broken')

    expect(results[0].excerpts[0].text).toContain('login redirect')
    expect(results[0].excerpts[0].text.startsWith('…')).toBe(true)
  })

  it('breaks a relevance tie by recency', () => {
    const conversations = [
      conversation({
        id: 'older',
        updatedAt: 10,
        messages: [message({ id: 'm1', role: 'user', content: 'login redirect issue' })]
      }),
      conversation({
        id: 'newer',
        updatedAt: 20,
        messages: [message({ id: 'm2', role: 'user', content: 'login redirect issue' })]
      })
    ]

    const results = searchTranscripts(conversations, 'login redirect issue')

    expect(results[0].conversationId).toBe('newer')
  })
})
