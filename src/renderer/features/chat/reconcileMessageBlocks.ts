import type { MessageBlock } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { stripToolCallText } from '@shared/toolCallText'

/**
 * During fallback recovery, raw tool-call JSON may already have streamed into
 * text blocks before the backend recognizes and executes it. Once generation
 * finishes, the backend returns cleaned content; this mirrors that cleanup in
 * the chronological render blocks so the real tool card becomes the UI.
 */
export function reconcileMessageBlocks(
  blocks: MessageBlock[] | undefined,
  finalContent: string,
  toolCalls: ToolCall[] | undefined
): MessageBlock[] | undefined {
  if (!blocks?.length) {
    return finalContent ? [{ type: 'text', text: finalContent }] : undefined
  }

  const toolNames = new Set(toolCalls?.map((call) => call.name) ?? [])
  if (toolNames.size === 0) {
    return finalContent ? [{ type: 'text', text: finalContent }] : undefined
  }

  const reconciled: MessageBlock[] = []
  for (const block of blocks) {
    if (block.type === 'tool') {
      reconciled.push(block)
      continue
    }

    const cleaned = stripToolCallText(block.text, toolNames)
    if (cleaned) reconciled.push({ type: 'text', text: cleaned })
  }

  const hasText = reconciled.some((block) => block.type === 'text')
  if (!hasText && finalContent) reconciled.push({ type: 'text', text: finalContent })
  return reconciled.length > 0 ? reconciled : undefined
}
