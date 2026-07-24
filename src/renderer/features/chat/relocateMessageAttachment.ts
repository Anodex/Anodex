import type { ChatAttachment } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { anodex } from '../../lib/anodex'
import { useChatStore } from '../../stores/chatStore'

export type RelocateAttachmentResult =
  { status: 'success' } | { status: 'cancelled' } | { status: 'error'; message: string }

export async function relocateMessageAttachment(
  messageId: string,
  originalPath: string
): Promise<RelocateAttachmentResult> {
  const picked = await anodex.attachments.pickImage()
  if (!picked) return { status: 'cancelled' }

  const read = await anodex.attachments.readFile(picked.path)
  if (!read.ok) return { status: 'error', message: read.error.message }
  if (read.value.kind !== 'image') {
    return { status: 'error', message: 'Choose a PNG, JPEG, GIF, or BMP image.' }
  }

  const state = useChatStore.getState()
  const conversation = state.conversations.find((item) => item.id === state.activeId)
  if (!conversation) return { status: 'error', message: 'The conversation is no longer open.' }

  const replacement: ChatAttachment = {
    path: picked.path,
    name: picked.name,
    sizeBytes: read.value.sizeBytes,
    kind: 'image',
    mimeType: read.value.mimeType
  }
  const updated = replaceMessageAttachment(conversation, messageId, originalPath, replacement)
  if (updated === conversation) {
    return {
      status: 'error',
      message: 'The missing attachment could not be found in this message.'
    }
  }

  try {
    await anodex.conversations.save(updated)
    useChatStore.setState((current) => ({
      conversations: current.conversations.map((item) => (item.id === updated.id ? updated : item))
    }))
    return { status: 'success' }
  } catch {
    return { status: 'error', message: 'Could not save the replacement image.' }
  }
}

export function replaceMessageAttachment(
  conversation: Conversation,
  messageId: string,
  originalPath: string,
  replacement: ChatAttachment
): Conversation {
  let replaced = false
  const messages = conversation.messages.map((message) => {
    if (message.id !== messageId || !message.attachments) return message
    const attachments = message.attachments.map((attachment) => {
      if (attachment.path !== originalPath) return attachment
      replaced = true
      return replacement
    })
    return replaced ? { ...message, attachments } : message
  })
  return replaced ? { ...conversation, messages, updatedAt: Date.now() } : conversation
}
