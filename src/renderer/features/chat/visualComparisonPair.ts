import type { ChatMessage } from '@shared/chat.types'
import type { ToolCall, ToolCallPreview } from '@shared/tools.types'
import type { ImagePreview } from './useVisualPreviewImage'

type HtmlPreview = Extract<ToolCallPreview, { kind: 'html' }>

export type VisualComparisonPair =
  | {
      kind: 'image'
      before: ImagePreview
      after: ImagePreview
      afterCallId: string
    }
  | {
      kind: 'html'
      before: HtmlPreview
      after: HtmlPreview
      afterCallId: string
    }

/**
 * Finds a comparison completed by the current assistant turn.
 *
 * Inspections compare the latest two captures of one workspace path, even when
 * the first capture was made in an earlier turn. HTML previews also compare
 * repeated paths, plus explicit Before/After snapshots such as before.html and
 * index.html. Unlabelled, unrelated files are never paired.
 */
export function latestVisualComparison(
  previousCalls: ToolCall[],
  currentCalls: ToolCall[]
): VisualComparisonPair | null {
  const imagePair = latestRepeatedImage(previousCalls, currentCalls)
  const htmlPair = latestHtmlPair(previousCalls, currentCalls)
  if (!imagePair) return htmlPair
  if (!htmlPair) return imagePair

  return currentCalls.findIndex((call) => call.id === imagePair.afterCallId) >
    currentCalls.findIndex((call) => call.id === htmlPair.afterCallId)
    ? imagePair
    : htmlPair
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

function latestRepeatedImage(
  previousCalls: ToolCall[],
  currentCalls: ToolCall[]
): Extract<VisualComparisonPair, { kind: 'image' }> | null {
  const previousByPath = new Map<string, ImagePreview>()

  for (const call of previousCalls) {
    const preview = inspectionPreview(call)
    if (preview) previousByPath.set(preview.path, preview)
  }

  let latest: Extract<VisualComparisonPair, { kind: 'image' }> | null = null
  for (const call of currentCalls) {
    const after = inspectionPreview(call)
    if (!after) continue
    const before = previousByPath.get(after.path)
    if (before) latest = { kind: 'image', before, after, afterCallId: call.id }
    previousByPath.set(after.path, after)
  }
  return latest
}

function latestHtmlPair(
  previousCalls: ToolCall[],
  currentCalls: ToolCall[]
): Extract<VisualComparisonPair, { kind: 'html' }> | null {
  const previousByPath = new Map<string, HtmlPreview>()

  for (const call of previousCalls) {
    const preview = htmlPreview(call)
    if (!preview) continue
    previousByPath.set(preview.path, preview)
  }

  let labelledBefore: HtmlPreview | null = null
  let latest: Extract<VisualComparisonPair, { kind: 'html' }> | null = null
  for (const call of currentCalls) {
    const after = htmlPreview(call)
    if (!after) continue
    const label = htmlComparisonLabel(call)
    const before = label === 'after' ? labelledBefore : previousByPath.get(after.path)
    if (before) latest = { kind: 'html', before, after, afterCallId: call.id }
    previousByPath.set(after.path, after)
    if (label === 'before') labelledBefore = after
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

function htmlPreview(call: ToolCall): HtmlPreview | null {
  return call.name === 'preview_html' && call.status === 'success' && call.preview?.kind === 'html'
    ? call.preview
    : null
}

function htmlComparisonLabel(call: ToolCall): 'before' | 'after' | null {
  const preview = htmlPreview(call)
  if (!preview) return null
  const label = `${preview.title} ${call.title} ${preview.path}`
  if (/\bbefore\b/i.test(label)) return 'before'
  if (/\bafter\b/i.test(label)) return 'after'
  return null
}
