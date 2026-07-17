import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { buildMessageEditBranch } from '../messageEdit'

function message(id: string, role: ChatMessage['role']): ChatMessage {
  return { id, role, content: id, createdAt: 1 }
}

function conversation(messages: ChatMessage[]): Conversation {
  return {
    id: 'c1',
    projectId: 'p1',
    title: 'Chat',
    messages,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('buildMessageEditBranch', () => {
  it('keeps earlier turns and returns discarded assistant ids in transcript order', () => {
    const chat = conversation([
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('u2', 'user'),
      message('a2', 'assistant'),
      message('u3', 'user'),
      message('a3', 'assistant')
    ])

    const branch = buildMessageEditBranch(chat, 'u2')

    expect(branch?.retainedMessages.map((item) => item.id)).toEqual(['u1', 'a1'])
    expect(branch?.discardedAssistantMessageIds).toEqual(['a2', 'a3'])
  })

  it('clears a compacted context snapshot when editing at or before its boundary', () => {
    const chat = conversation([
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('u2', 'user'),
      message('a2', 'assistant')
    ])
    chat.context = {
      activeSnapshot: {
        id: 'ctx1',
        summary: 'old summary',
        throughMessageId: 'a1',
        reason: 'manual',
        removedTurns: 2,
        createdAt: 1
      }
    }

    expect(buildMessageEditBranch(chat, 'u1')?.clearContext).toBe(true)
    expect(buildMessageEditBranch(chat, 'u2')?.clearContext).toBe(false)

    if (chat.context?.activeSnapshot) chat.context.activeSnapshot.throughMessageId = null
    expect(buildMessageEditBranch(chat, 'u2')?.clearContext).toBe(true)
  })

  it('rejects missing and assistant message targets', () => {
    const chat = conversation([message('u1', 'user'), message('a1', 'assistant')])

    expect(buildMessageEditBranch(chat, 'missing')).toBeNull()
    expect(buildMessageEditBranch(chat, 'a1')).toBeNull()
  })
})
