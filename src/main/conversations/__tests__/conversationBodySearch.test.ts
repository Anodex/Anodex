import { describe, expect, it } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import { searchConversationBodies } from '../conversationBodySearch'

function conversation(id: string, ...contents: string[]): Conversation {
  return {
    id,
    projectId: null,
    title: 'Untitled',
    createdAt: 1,
    updatedAt: 1,
    messages: contents.map((content, index) => ({
      id: `${id}-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content,
      createdAt: 1
    }))
  }
}

describe('searchConversationBodies', () => {
  const store = [
    conversation('nebula', 'Build the nebula shader', 'Added a volumetric fog pass to the nebula.'),
    conversation('email', 'Which unread emails need a reply?', 'Neither needs a reply.')
  ]

  it('finds a conversation by something said in it, with the passage that matched', () => {
    // The title of both is "Untitled": only the body can find either.
    const hits = searchConversationBodies(store, 'volumetric fog')

    expect(hits.map((hit) => hit.conversationId)).toEqual(['nebula'])
    expect(hits[0].excerpt).toContain('volumetric fog')
  })

  it('returns nothing for a query too short to mean anything', () => {
    expect(searchConversationBodies(store, 're')).toEqual([])
    expect(searchConversationBodies(store, '   ')).toEqual([])
  })

  it('returns nothing rather than recent chats when nothing matches', () => {
    expect(searchConversationBodies(store, 'kubernetes ingress')).toEqual([])
  })
})
