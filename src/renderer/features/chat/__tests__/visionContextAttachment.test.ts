import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import { setImageVisionContext } from '../visionContextAttachment'

vi.mock('../../../lib/anodex', () => ({
  anodex: { conversations: { save: vi.fn() } }
}))

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: { getState: vi.fn(), setState: vi.fn() }
}))

const CONVERSATION: Conversation = {
  id: 'conversation-1',
  projectId: null,
  title: 'Visual follow-up',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'Look at this image',
      createdAt: 1,
      attachments: [
        {
          path: 'C:\\Pictures\\screen.png',
          name: 'screen.png',
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: 12
        },
        { path: 'notes.txt', name: 'notes.txt', kind: 'text', sizeBytes: 4 }
      ]
    }
  ]
}

describe('setImageVisionContext', () => {
  it('persists the explicit image follow-up choice without touching other attachments', () => {
    const updated = setImageVisionContext(
      CONVERSATION,
      'message-1',
      'C:\\Pictures\\screen.png',
      true
    )

    expect(updated).not.toBe(CONVERSATION)
    expect(updated.messages[0].attachments).toEqual([
      expect.objectContaining({ visionContextPinned: true }),
      CONVERSATION.messages[0].attachments?.[1]
    ])
  })

  it('removes the opt-in flag when an image is no longer kept', () => {
    const kept = setImageVisionContext(CONVERSATION, 'message-1', 'C:\\Pictures\\screen.png', true)
    const updated = setImageVisionContext(kept, 'message-1', 'C:\\Pictures\\screen.png', false)

    expect(updated.messages[0].attachments?.[0]).not.toHaveProperty('visionContextPinned')
  })

  it('does nothing when the requested attachment is not an image', () => {
    expect(setImageVisionContext(CONVERSATION, 'message-1', 'notes.txt', true)).toBe(CONVERSATION)
  })
})
