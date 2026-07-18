import type { ChatHistoryTurn, ChatMessage, MessageBlock } from './chat.types'
import type { Conversation } from './conversation.types'
import { TOOL_CATALOG } from './tools.types'
import { detectToolCallText } from './toolCallText'

const KNOWN_TOOL_NAMES = new Set(TOOL_CATALOG.map((tool) => tool.name))

export function sanitizeAssistantContent(text: string): string {
  return stripKnownToolCallPayloads(text).text
}

export function sanitizeHistoryTurn(turn: ChatHistoryTurn): ChatHistoryTurn {
  if (turn.role !== 'assistant') return turn
  const { text, changed } = stripKnownToolCallPayloads(turn.content)
  return changed ? { ...turn, content: text } : turn
}

export function messageToHistoryTurn(message: ChatMessage): ChatHistoryTurn {
  return sanitizeHistoryTurn({
    id: message.id,
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls
  })
}

export function sanitizeMessageTranscript(message: ChatMessage): {
  message: ChatMessage
  changed: boolean
} {
  if (message.role !== 'assistant') return { message, changed: false }

  const content = stripKnownToolCallPayloads(message.content)
  const blocks = sanitizeBlocks(message.blocks)
  if (!content.changed && !blocks.changed) return { message, changed: false }

  return {
    message: {
      ...message,
      content: content.text,
      blocks: blocks.blocks
    },
    changed: true
  }
}

export function sanitizeConversationTranscript(conversation: Conversation): {
  conversation: Conversation
  changed: boolean
} {
  let changed = false
  const messages = conversation.messages.map((message) => {
    const result = sanitizeMessageTranscript(message)
    if (result.changed) changed = true
    return result.message
  })

  return changed
    ? { conversation: { ...conversation, messages }, changed }
    : { conversation, changed }
}

function sanitizeBlocks(blocks: MessageBlock[] | undefined): {
  blocks: MessageBlock[] | undefined
  changed: boolean
} {
  if (!blocks?.length) return { blocks, changed: false }

  let changed = false
  const sanitized: MessageBlock[] = []
  for (const block of blocks) {
    // Same reasoning as `truncateTextBlocks` in `streamingToolPayload.ts`:
    // a known tool-call payload can only leak into the visible reply, never
    // into thinking (a separate stream, never scanned for this) — pass it
    // through untouched like a tool block, not relabel it as text below.
    if (block.type === 'tool' || block.type === 'thinking') {
      sanitized.push(block)
      continue
    }

    const { text, changed: textChanged } = stripKnownToolCallPayloads(block.text)
    if (textChanged) changed = true
    if (text) sanitized.push(textChanged ? { type: 'text', text } : block)
    else changed = true
  }

  return {
    blocks: sanitized.length > 0 ? sanitized : undefined,
    changed
  }
}

function stripKnownToolCallPayloads(text: string): { text: string; changed: boolean } {
  let cleaned = text
  let changed = false

  for (;;) {
    const match = detectToolCallText(cleaned, KNOWN_TOOL_NAMES)
    if (!match) break
    cleaned = cleaned.replace(match.matchedText, '')
    changed = true
  }

  return {
    text: changed ? cleaned.trim() : text,
    changed
  }
}
