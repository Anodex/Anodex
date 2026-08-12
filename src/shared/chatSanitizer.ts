import type { ChatHistoryTurn, ChatMessage, MessageBlock } from './chat.types'
import type { Conversation } from './conversation.types'
import { TOOL_CATALOG, type ToolCall } from './tools.types'
import { detectToolCallText } from './toolCallText'

const KNOWN_TOOL_NAMES = new Set(TOOL_CATALOG.map((tool) => tool.name))

export const INTERRUPTED_GENERATION_MESSAGE =
  'Anodex was closed before this reply finished. The text and completed work above were preserved.'

export function sanitizeAssistantContent(text: string): string {
  return stripKnownToolCallPayloads(text).text
}

export function sanitizeHistoryTurn(turn: ChatHistoryTurn): ChatHistoryTurn {
  if (turn.role !== 'assistant') return turn
  const content = stripKnownToolCallPayloads(turn.content)
  const toolCalls = sanitizeToolCalls(turn.toolCalls, 'history')
  return content.changed || toolCalls.changed
    ? { ...turn, content: content.text, toolCalls: toolCalls.toolCalls }
    : turn
}

export function messageToHistoryTurn(message: ChatMessage): ChatHistoryTurn {
  return sanitizeHistoryTurn({
    id: message.id,
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    attachments: message.attachments
  })
}

export function sanitizeMessageTranscript(
  message: ChatMessage,
  options?: { preserveImageData?: boolean }
): {
  message: ChatMessage
  changed: boolean
} {
  if (message.role !== 'assistant') return { message, changed: false }

  const mode = options?.preserveImageData ? 'render' : 'persistence'
  const content = stripKnownToolCallPayloads(message.content)
  const toolCalls = sanitizeToolCalls(message.toolCalls, mode)
  const blocks = sanitizeBlocks(message.blocks, mode)
  if (!content.changed && !toolCalls.changed && !blocks.changed) {
    return { message, changed: false }
  }

  return {
    message: {
      ...message,
      content: content.text,
      toolCalls: toolCalls.toolCalls,
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

/**
 * A streaming flag only has meaning while its renderer and main-process
 * generation are both alive. If it reached disk, the app exited before that
 * generation could settle, so leaving it live on the next launch traps the
 * composer in its queued-message state with no generation left to stop.
 */
export function reconcileInterruptedConversation(conversation: Conversation): {
  conversation: Conversation
  changed: boolean
} {
  let changed = false
  const messages = conversation.messages.map((message) => {
    if (!message.streaming) return message
    changed = true
    const toolCalls = message.toolCalls?.map(settleInterruptedToolCall)
    const blocks = message.blocks?.map((block) =>
      block.type === 'tool' ? { ...block, call: settleInterruptedToolCall(block.call) } : block
    )
    return {
      ...message,
      streaming: false,
      error: message.error ?? INTERRUPTED_GENERATION_MESSAGE,
      toolCalls,
      blocks
    }
  })

  return changed
    ? { conversation: { ...conversation, messages }, changed }
    : { conversation, changed }
}

type ToolCallSanitizeMode = 'history' | 'persistence' | 'render'

function sanitizeBlocks(
  blocks: MessageBlock[] | undefined,
  mode: ToolCallSanitizeMode
): {
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
    if (block.type === 'tool') {
      const call = sanitizeToolCall(block.call, mode)
      if (call.changed) changed = true
      sanitized.push(call.changed ? { ...block, call: call.call } : block)
      continue
    }
    if (block.type === 'thinking') {
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

function sanitizeToolCalls(
  toolCalls: ToolCall[] | undefined,
  mode: ToolCallSanitizeMode
): {
  toolCalls: ToolCall[] | undefined
  changed: boolean
} {
  if (!toolCalls?.length) return { toolCalls, changed: false }
  let changed = false
  const sanitized = toolCalls.map((call) => {
    const result = sanitizeToolCall(call, mode)
    if (result.changed) changed = true
    return result.call
  })
  return { toolCalls: changed ? sanitized : toolCalls, changed }
}

/** Keep pixels in live rendering, durable refs on disk, and neither in model-history replay. */
function sanitizeToolCall(
  call: ToolCall,
  mode: ToolCallSanitizeMode
): { call: ToolCall; changed: boolean } {
  if (call.preview?.kind !== 'image') return { call, changed: false }
  if (mode === 'render') return { call, changed: false }
  if (mode === 'history' || !call.preview.asset) {
    return { call: { ...call, preview: undefined }, changed: true }
  }
  const { dataUrl: _dataUrl, sections, ...durablePreview } = call.preview
  const durableSections = sections?.map(({ dataUrl: _sectionDataUrl, ...section }) => section)
  const preview = durableSections
    ? { ...durablePreview, sections: durableSections }
    : durablePreview
  if (!call.preview.dataUrl && !sections?.some((section) => section.dataUrl)) {
    return { call, changed: false }
  }
  return { call: { ...call, preview }, changed: true }
}

function settleInterruptedToolCall(call: ToolCall): ToolCall {
  return call.status === 'running'
    ? { ...call, status: 'error', detail: 'Interrupted when Anodex closed.' }
    : call
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
