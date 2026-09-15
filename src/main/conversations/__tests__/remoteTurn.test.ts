import { describe, expect, it, vi } from 'vitest'
import type { ChatRequest } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'

vi.mock('../ConversationStore', () => ({ conversationStore: {} }))

import { remoteQuestionConversation, remoteTurnConversation } from '../remoteTurn'

const stats = { tokens: 3, durationMs: 900, tokensPerSecond: 3.3 }

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    conversationId: 'c1',
    messageId: 'm1',
    projectId: null,
    history: [],
    prompt: 'Which of my 4 unread emails need a reply?',
    ...overrides
  }
}

describe('remoteTurnConversation', () => {
  it("creates the conversation a phone never got to save, with the phone's ids", () => {
    // The reported case: the phone stopped waiting, so the only record of the turn
    // has to come from the computer.
    const saved = remoteTurnConversation(undefined, request(), { content: 'Neither.', stats }, 5)

    expect(saved).toMatchObject({
      id: 'c1',
      projectId: null,
      title: 'Which of my 4 unread emails need a reply?',
      createdAt: 5,
      updatedAt: 5
    })
    expect(saved?.messages.map((message) => [message.id, message.role, message.content])).toEqual([
      ['m1', 'user', 'Which of my 4 unread emails need a reply?'],
      ['m1:reply', 'assistant', 'Neither.']
    ])
  })

  it('adds to a conversation that already exists rather than retitling it', () => {
    const existing: Conversation = {
      id: 'c1',
      projectId: 'p1',
      title: 'Inbox Triage',
      createdAt: 1,
      updatedAt: 2,
      messages: [{ id: 'm1', role: 'user', content: 'Which…', createdAt: 1 }]
    }

    const saved = remoteTurnConversation(existing, request(), { content: 'Neither.', stats }, 9)

    expect(saved?.title).toBe('Inbox Triage')
    expect(saved?.projectId).toBe('p1')
    expect(saved?.updatedAt).toBe(9)
  })

  it('titles an empty "New chat" made at the desk from its first question', () => {
    // Seen on the emulator: a chat created in a project at the desk and first used on
    // the phone kept "New chat" after its reply.
    const empty: Conversation = {
      id: 'c1',
      projectId: 'p1',
      title: 'New chat',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    }

    const saved = remoteTurnConversation(empty, request(), { content: 'Neither.', stats }, 9)

    expect(saved?.title).toBe('Which of my 4 unread emails need a reply?')
    expect(saved?.projectId).toBe('p1')
    expect(saved?.createdAt).toBe(1)
  })

  it('keeps "New chat" as the name of a conversation that already has turns', () => {
    const named: Conversation = {
      id: 'c1',
      projectId: null,
      title: 'New chat',
      createdAt: 1,
      updatedAt: 2,
      messages: [{ id: 'm0', role: 'user', content: 'Earlier', createdAt: 1 }]
    }

    const saved = remoteTurnConversation(named, request(), { content: 'Neither.', stats }, 9)

    expect(saved?.title).toBe('New chat')
  })

  it('takes a plain first line for the title of a pasted prompt', () => {
    const saved = remoteTurnConversation(
      undefined,
      request({ prompt: '\n**Build the nebula**\nwith these steps' }),
      { content: 'ok', stats },
      1
    )
    expect(saved?.title).toBe('Build the nebula')
  })

  it("writes a phone's new conversation as its question, before any answer", () => {
    const started = remoteQuestionConversation(undefined, request({ projectId: 'p1' }), 4)

    expect(started).toEqual({
      id: 'c1',
      projectId: 'p1',
      title: 'Which of my 4 unread emails need a reply?',
      createdAt: 4,
      updatedAt: 4,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'Which of my 4 unread emails need a reply?',
          createdAt: 4
        }
      ]
    })
    // The finished turn then lands on it, adding the reply under the same ids.
    const finished = remoteTurnConversation(started, request(), { content: 'Neither.', stats }, 9)
    expect(finished?.messages.map((message) => message.id)).toEqual(['m1', 'm1:reply'])
    expect(finished?.createdAt).toBe(4)
  })

  it('writes no question for a conversation that already exists', () => {
    const existing: Conversation = {
      id: 'c1',
      projectId: null,
      title: 'Inbox Triage',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    }
    expect(remoteQuestionConversation(existing, request(), 4)).toBeNull()
  })

  it('writes nothing for an answer that carries nothing', () => {
    expect(remoteTurnConversation(undefined, request(), { content: '   ', stats }, 1)).toBeNull()
  })
})
