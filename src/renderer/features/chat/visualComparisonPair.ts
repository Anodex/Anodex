import type { ChatMessage } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import type { ImagePreview } from './useVisualPreviewImage'

export interface VisualComparisonPair {
  before: ImagePreview
  after: ImagePreview
  afterCallId: string
}

/**
 * Finds a comparison completed by the current assistant turn.
 *
 * Inspections compare the latest two screenshot captures of one workspace path,
 * even when the first capture was made in an earlier turn. Inline HTML previews
 * are deliberately excluded because they are interactive documents, not
 * captured visual evidence.
 */
export function latestVisualComparison(
  previousCalls: ToolCall[],
  currentCalls: ToolCall[]
): VisualComparisonPair | null {
  return latestRepeatedInspection(previousCalls, currentCalls)
}

/** Derives at most one comparison per assistant message without persisted UI state. */
export function visualComparisonsByMessage(
  messages: ChatMessage[]
): ReadonlyMap<string, VisualComparisonPair> {
  const comparisons = new Map<string, VisualComparisonPair>()
  const previousCalls: ToolCall[] = []

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const currentCalls = message.toolCalls ?? []
    const comparison = latestVisualComparison(previousCalls, currentCalls)
    if (comparison) comparisons.set(message.id, comparison)
    previousCalls.push(...currentCalls)
  }

  return comparisons
}

function latestRepeatedInspection(
  previousCalls: ToolCall[],
  currentCalls: ToolCall[]
): VisualComparisonPair | null {
  const previousByPath = new Map<string, ImagePreview>()

  for (const call of previousCalls) {
    const preview = inspectionPreview(call)
    if (preview) previousByPath.set(preview.path, preview)
  }

  let latest: VisualComparisonPair | null = null
  for (const call of currentCalls) {
    const after = inspectionPreview(call)
    if (!after) continue
    const before = previousByPath.get(after.path)
    if (before) latest = { before, after, afterCallId: call.id }
    previousByPath.set(after.path, after)
  }
  return latest
}

function inspectionPreview(call: ToolCall): ImagePreview | null {
  return call.name === 'inspect_visual' &&
    call.status === 'success' &&
    call.preview?.kind === 'image'
    ? call.preview
    : null
}
