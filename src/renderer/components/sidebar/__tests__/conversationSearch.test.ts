import { describe, expect, it } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import type { ChatMessage } from '@shared/chat.types'
import { findBodyMatches, matchesQuery } from '../conversationSearch'

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, createdAt: 1 }
}

function conversation(id: string, title: string, messages: ChatMessage[]): Conversation {
  return { id, projectId: null, title, messages, createdAt: 1, updatedAt: 1 }
}

describe('matchesQuery', () => {
  it('matches case-insensitively', () => {
    expect(matchesQuery('Deploy Notes', 'deploy')).toBe(true)
    expect(matchesQuery('Deploy Notes', 'DEPLOY')).toBe(true)
    expect(matchesQuery('Deploy Notes', 'rollback')).toBe(false)
  })
})

describe('findBodyMatches', () => {
  const chats = [
    conversation('c1', 'Untitled', [
      message('m1', 'user', 'How do I configure the postgres connection pool?'),
      message('m2', 'assistant', 'Set max_connections in the config file.')
    ]),
    conversation('c2', 'Grocery list', [message('m3', 'user', 'milk, eggs, bread')])
  ]

  it('finds a conversation by something said inside it, not its title', () => {
    const matches = findBodyMatches(chats, 'postgres connection pool')
    expect(matches.ids.has('c1')).toBe(true)
    expect(matches.ids.has('c2')).toBe(false)
  })

  it('carries an excerpt so the row can say why it surfaced', () => {
    const matches = findBodyMatches(chats, 'postgres connection pool')
    expect(matches.excerpts.get('c1')).toContain('postgres')
  })

  it('finds assistant messages too, not just what the user typed', () => {
    const matches = findBodyMatches(chats, 'max_connections')
    expect(matches.ids.has('c1')).toBe(true)
  })

  it('returns nothing for an empty or whitespace query', () => {
    expect(findBodyMatches(chats, '').ids.size).toBe(0)
    expect(findBodyMatches(chats, '   ').ids.size).toBe(0)
    expect(findBodyMatches(chats, '').excerpts.size).toBe(0)
  })

  it('returns nothing when the query matches no message', () => {
    expect(findBodyMatches(chats, 'kubernetes').ids.size).toBe(0)
  })

  it('raises the result cap well above the prompt-injection default of 3', () => {
    // The recall default bounds prompt size; a user-facing search that
    // silently stopped at three hits would be worse than no search.
    const many = Array.from({ length: 12 }, (_, index) =>
      conversation(`c${index}`, 'Untitled', [
        message(`m${index}`, 'user', 'the postgres connection pool question again')
      ])
    )
    expect(findBodyMatches(many, 'postgres connection pool').ids.size).toBe(12)
  })
})
