import type { MessageBlock } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import {
  stripLeakedChannelTokens,
  stripSubstantialCodeFences,
  stripToolCallText
} from '@shared/toolCallText'

/**
 * During fallback recovery, raw tool-call JSON may already have streamed into
 * text blocks before the backend recognizes and executes it. Once generation
 * finishes, the backend returns cleaned content; this mirrors that cleanup in
 * the chronological render blocks so the real tool card becomes the UI.
 *
 * Also mirrors two other backend cleanup passes (see `LlamaService.ts`): a
 * leaked chat-template segment marker (`stripLeakedChannelTokens`, applied
 * unconditionally — it's not a "should have used a tool" concern, just a
 * template artifact) and the substantial-code-fence stripping
 * (`stripSubstantialCodeFences`). The flat `content` string and the
 * chronological block list are two separate representations built from the
 * same stream, and both need the identical cleanup or one ends up clean
 * while the other still shows the raw artifact. `userPrompt`/`hasEditTool`
 * are passed through so the code-fence decision matches the backend's
 * exactly (same "did the user explicitly ask to see code" and "is there an
 * edit tool to have done this for real" carve-outs).
 */
export function reconcileMessageBlocks(
  blocks: MessageBlock[] | undefined,
  finalContent: string,
  toolCalls: ToolCall[] | undefined,
  extraToolNames: readonly string[] = [],
  userPrompt = '',
  hasEditTool = false
): MessageBlock[] | undefined {
  if (!blocks?.length) {
    return finalContent ? [{ type: 'text', text: finalContent }] : undefined
  }

  const toolNames = new Set([...(toolCalls?.map((call) => call.name) ?? []), ...extraToolNames])
  if (toolNames.size === 0) {
    // No tools this turn, so there's no fallback-tool-call-JSON concern to
    // clean up in the visible text — trust `finalContent` wholesale, same as
    // before. But any thinking blocks captured live must survive this
    // shortcut too, instead of being silently discarded — they always
    // precede the answer they led to, so they keep their original relative
    // order ahead of the final text.
    const thinkingBlocks = blocks.filter((block) => block.type === 'thinking')
    const result: MessageBlock[] = [...thinkingBlocks]
    if (finalContent) result.push({ type: 'text', text: finalContent })
    return result.length > 0 ? result : undefined
  }

  const reconciled: MessageBlock[] = []
  for (const block of blocks) {
    // Thinking is a separate stream, never scanned for tool-call payloads —
    // pass it through untouched, same as a tool block.
    if (block.type === 'tool' || block.type === 'thinking') {
      reconciled.push(block)
      continue
    }

    const strippedCall = stripLeakedChannelTokens(stripToolCallText(block.text, toolNames))
    const cleaned = hasEditTool
      ? stripSubstantialCodeFences(strippedCall, userPrompt)
      : strippedCall
    if (cleaned) reconciled.push({ type: 'text', text: cleaned })
  }

  const hasText = reconciled.some((block) => block.type === 'text')
  if (!hasText && finalContent) reconciled.push({ type: 'text', text: finalContent })
  return reconciled.length > 0 ? reconciled : undefined
}
