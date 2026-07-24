import { useEffect, useState } from 'react'
import type { ToolCallPreview } from '@shared/tools.types'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import { anodex } from '../../lib/anodex'
import styles from './ChatImagePreview.module.css'

type ImagePreview = Extract<ToolCallPreview, { kind: 'image' }>

/** Exact inspected pixels, loaded live from memory or later from the durable asset store. */
export function ChatImagePreview({ preview }: { preview: ImagePreview }): JSX.Element {
  const [dataUrl, setDataUrl] = useState(preview.dataUrl ?? null)
  const [unavailable, setUnavailable] = useState(!preview.dataUrl && !preview.asset)

  useEffect(() => {
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
  }, [preview.asset, preview.dataUrl])

  return (
    <figure className={styles.wrap}>
      <figcaption className={styles.header}>
        <span className={styles.title}>{preview.title}</span>
        <span className={styles.path}>{preview.path}</span>
      </figcaption>
      <div className={styles.canvas}>
        {dataUrl ? (
          <ExpandableImage
            src={dataUrl}
            alt={`Visual inspection of ${preview.path}`}
            title={preview.title}
            imageClassName={styles.image}
            triggerClassName={styles.imageButton}
          />
        ) : (
          <span className={styles.notice}>
            {unavailable
              ? 'This inspected screenshot is no longer available.'
              : 'Loading screenshot…'}
          </span>
        )}
      </div>
    </figure>
  )
}
