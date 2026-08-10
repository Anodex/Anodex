import type { Conversation } from '@shared/conversation.types'
import { anodex } from '../../lib/anodex'
import { useChatStore } from '../../stores/chatStore'

export type UpdateVisionContextResult = { status: 'success' } | { status: 'error'; message: string }

/** Persist one image's deliberate opt-in to later vision-model requests. */
export async function updateImageVisionContext(
  messageId: string,
  path: string,
  visionContextPinned: boolean
): Promise<UpdateVisionContextResult> {
  const state = useChatStore.getState()
  const conversation = state.conversations.find((item) => item.id === state.activeId)
  if (!conversation) return { status: 'error', message: 'The conversation is no longer open.' }

  const updated = setImageVisionContext(conversation, messageId, path, visionContextPinned)
  if (updated === conversation) {
    return { status: 'error', message: 'The image could not be found in this message.' }
  }

  try {
    await anodex.conversations.save(updated)
    useChatStore.setState((current) => ({
      conversations: current.conversations.map((item) => (item.id === updated.id ? updated : item))
    }))
    return { status: 'success' }
  } catch {
    return { status: 'error', message: 'Could not save the visual follow-up setting.' }
  }
}

export function setImageVisionContext(
  conversation: Conversation,
  messageId: string,
  path: string,
  visionContextPinned: boolean
): Conversation {
  let changed = false
  const messages = conversation.messages.map((message) => {
    if (message.id !== messageId || !message.attachments) return message
    const attachments = message.attachments.map((attachment) => {
      if (attachment.path !== path || attachment.kind !== 'image') return attachment
      if (Boolean(attachment.visionContextPinned) === visionContextPinned) return attachment
      changed = true
      if (visionContextPinned) return { ...attachment, visionContextPinned: true }
      const { visionContextPinned: _removed, ...unpinned } = attachment
      return unpinned
    })
    return changed ? { ...message, attachments } : message
  })
  return changed ? { ...conversation, messages, updatedAt: Date.now() } : conversation
}
