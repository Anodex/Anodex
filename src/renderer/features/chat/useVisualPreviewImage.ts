import { useEffect, useState } from 'react'
import type { ToolCallPreview } from '@shared/tools.types'
import { anodex } from '../../lib/anodex'

export type ImagePreview = Extract<ToolCallPreview, { kind: 'image' }>

export interface VisualPreviewImageState {
  dataUrl: string | null
  unavailable: boolean
}

/** Loads live preview pixels or reopens their durable conversation asset. */
export function useVisualPreviewImage(
  preview: ImagePreview,
  enabled = true
): VisualPreviewImageState {
  const [dataUrl, setDataUrl] = useState(enabled ? (preview.dataUrl ?? null) : null)
  const [unavailable, setUnavailable] = useState(enabled && !preview.dataUrl && !preview.asset)

  useEffect(() => {
    if (!enabled) {
      setDataUrl(null)
      setUnavailable(false)
      return undefined
    }
    if (preview.dataUrl) {
      setDataUrl(preview.dataUrl)
      setUnavailable(false)
      return undefined
    }
    if (!preview.asset) {
      setDataUrl(null)
      setUnavailable(true)
      return undefined
    }

    let cancelled = false
    setDataUrl(null)
    setUnavailable(false)
    void anodex.conversations
      .readVisualPreview(preview.asset.conversationId, preview.asset.id)
      .then((result) => {
        if (cancelled) return
        if (result.ok) setDataUrl(result.value.dataUrl)
        else setUnavailable(true)
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, preview.asset, preview.dataUrl])

  return { dataUrl, unavailable }
}
