import type { ChatMessage, MessageBlock } from '@shared/chat.types'
import { findPotentialToolCallTextStart } from '@shared/toolCallText'

export type PendingToolPayloads = Map<string, string>

export function quarantineStreamingToolPayload(
  message: ChatMessage,
  token: string,
  pendingToolPayloads: PendingToolPayloads
): string {
  const pending = pendingToolPayloads.get(message.id)
  if (pending !== undefined) {
    pendingToolPayloads.set(message.id, pending + token)
    return ''
  }

  const originalContentLength = message.content.length
  const combined = message.content + token
  const start = findPotentialToolCallTextStart(combined)
  if (start === -1) return token

  const visibleLength = Math.min(start, originalContentLength)
  if (visibleLength < originalContentLength) {
    message.content = message.content.slice(0, visibleLength).trimEnd()
    message.blocks = truncateTextBlocks(message.blocks, message.content.length)
  }

  const visibleToken =
    start > originalContentLength ? token.slice(0, start - originalContentLength) : ''
  pendingToolPayloads.set(message.id, combined.slice(start))
  return visibleToken
}

function truncateTextBlocks(
  blocks: MessageBlock[] | undefined,
  maxTextLength: number
): MessageBlock[] | undefined {
  if (!blocks) return blocks

  let remaining = maxTextLength
  const truncated: MessageBlock[] = []
  for (const block of blocks) {
    if (block.type === 'tool') {
      truncated.push(block)
      continue
    }

    if (remaining <= 0) break
    const text = block.text.slice(0, remaining)
    if (text) truncated.push({ type: 'text', text })
    remaining -= text.length
  }

  return truncated.length > 0 ? truncated : undefined
}
