import { describe, expect, it } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import type { ChatMessage } from '@shared/chat.types'
import { branchForEdit } from '../branchForEdit'

/** Cutting a conversation back so an edited question can replace the original. */
describe('branchForEdit', () => {
  const message = (id: string, role: ChatMessage['role']): ChatMessage => ({
    id,
    role,
    content: id,
    createdAt: 1
  })

  const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
    id: 'c1',
    title: 't',
    projectId: null,
    createdAt: 1,
    updatedAt: 1,
    messages: [
      message('q1', 'user'),
      message('a1', 'assistant'),
      message('q2', 'user'),
      message('a2', 'assistant')
    ],
    ...overrides
  })

  it('keeps everything before the question, and drops it and what follows', () => {
    const outcome = branchForEdit(conversation(), 'q2', 99)

    expect(outcome.ok && outcome.conversation.messages.map((m) => m.id)).toEqual(['q1', 'a1'])
    expect(outcome.ok && outcome.conversation.updatedAt).toBe(99)
  })

  it('refuses anything that is not a question in this conversation', () => {
    expect(branchForEdit(conversation(), 'a1', 1)).toEqual({ ok: false, reason: 'not-a-question' })
    expect(branchForEdit(conversation(), 'nope', 1)).toEqual({
      ok: false,
      reason: 'not-a-question'
    })
    expect(branchForEdit(null, 'q1', 1)).toEqual({ ok: false, reason: 'not-found' })
  })

  it('refuses a project chat whose later replies would be thrown away', () => {
    const inProject = conversation({ projectId: 'p1' })

    expect(branchForEdit(inProject, 'q1', 1)).toEqual({ ok: false, reason: 'project-chat' })
  })

  it('allows a project chat when nothing after the question has answered yet', () => {
    const unanswered = conversation({
      projectId: 'p1',
      messages: [message('q1', 'user'), message('a1', 'assistant'), message('q2', 'user')]
    })

    expect(branchForEdit(unanswered, 'q2', 1).ok).toBe(true)
  })

  it('drops a context snapshot that covered the removed turns', () => {
    const summarised = conversation({
      context: {
        activeSnapshot: {
          id: 's',
          createdAt: 1,
          reason: 'manual',
          throughMessageId: 'a2',
          removedTurns: 3,
          summary: 'x'
        }
      }
    })

    const outcome = branchForEdit(summarised, 'q2', 1)

    expect(outcome.ok && outcome.conversation.context).toBeNull()
  })
})
