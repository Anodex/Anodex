import { describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { replaceMessageAttachment } from '../relocateMessageAttachment'

vi.mock('../../../lib/anodex', () => ({ anodex: {} }))
vi.mock('../../../stores/chatStore', () => ({ useChatStore: {} }))

const ORIGINAL: ChatAttachment = {
  path: 'C:\\old\\robot.png',
  name: 'robot.png',
  sizeBytes: 10,
  kind: 'image',
  mimeType: 'image/png'
}

const CONVERSATION: Conversation = {
  id: 'conversation-1',
  projectId: null,
  title: 'Image chat',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'Look at this',
      createdAt: 1,
      attachments: [ORIGINAL]
    }
  ],
  createdAt: 1,
  updatedAt: 1
}

describe('replaceMessageAttachment', () => {
  it('replaces only the matching attachment metadata', () => {
    const replacement: ChatAttachment = {
      ...ORIGINAL,
      path: 'D:\\found\\robot.png',
      sizeBytes: 20
    }
    const updated = replaceMessageAttachment(CONVERSATION, 'message-1', ORIGINAL.path, replacement)

    expect(updated).not.toBe(CONVERSATION)
    expect(updated.messages[0].attachments).toEqual([replacement])
    expect(updated.updatedAt).toBeGreaterThan(1)
  })

  it('leaves the conversation untouched when the target is absent', () => {
    expect(replaceMessageAttachment(CONVERSATION, 'message-missing', ORIGINAL.path, ORIGINAL)).toBe(
      CONVERSATION
    )
  })
})
