import type { ToolCall } from '@shared/tools.types'
import type { ImagePreview } from './useVisualPreviewImage'

export interface InspectionComparisonPair {
  before: ImagePreview
  after: ImagePreview
}

/**
 * Finds the two most recent successful inspections of the same workspace path.
 * Different files are never compared merely because they were inspected in one turn.
 */
export function latestInspectionComparison(calls: ToolCall[]): InspectionComparisonPair | null {
  const byPath = new Map<string, Array<{ index: number; preview: ImagePreview }>>()

  calls.forEach((call, index) => {
    if (
      call.name !== 'inspect_visual' ||
      call.status !== 'success' ||
      call.preview?.kind !== 'image'
    ) {
      return
    }
    const entries = byPath.get(call.preview.path) ?? []
    entries.push({ index, preview: call.preview })
    byPath.set(call.preview.path, entries)
  })

  let latest: Array<{ index: number; preview: ImagePreview }> | null = null
  for (const entries of byPath.values()) {
    if (entries.length < 2) continue
    if (!latest || entries[entries.length - 1].index > latest[latest.length - 1].index) {
      latest = entries
    }
  }
  if (!latest) return null

  return {
    before: latest[latest.length - 2].preview,
    after: latest[latest.length - 1].preview
  }
}
