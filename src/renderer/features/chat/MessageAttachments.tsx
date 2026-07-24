import { useEffect, useState } from 'react'
import type { ChatAttachment } from '@shared/chat.types'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import { formatBytes } from '../../lib/format'
import { loadAttachmentImage } from './loadAttachmentImage'
import styles from './MessageAttachments.module.css'

export function MessageAttachments({
  attachments
}: {
  attachments: ChatAttachment[]
}): JSX.Element {
  const images = attachments.filter((attachment) => attachment.kind === 'image')
  const files = attachments.filter((attachment) => attachment.kind !== 'image')

  return (
    <>
      {images.length > 0 && (
        <div className={styles.images}>
          {images.map((attachment) => (
            <InlineImageAttachment key={attachment.path} attachment={attachment} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className={styles.files}>
          {files.map((attachment) => (
            <span key={attachment.path} className={styles.file} title={attachment.path}>
              <FileTypeIcon fileName={attachment.name} size={13} />
              <span className={styles.fileName}>{attachment.name}</span>
              <span className={styles.fileSize}>{formatBytes(attachment.sizeBytes)}</span>
            </span>
          ))}
        </div>
      )}
    </>
  )
}

function InlineImageAttachment({ attachment }: { attachment: ChatAttachment }): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDataUrl(null)
    setUnavailable(false)
    void loadAttachmentImage(attachment).then((result) => {
      if (cancelled) return
      setDataUrl(result)
      setUnavailable(result === null)
    })
    return () => {
      cancelled = true
    }
  }, [attachment])

  return (
    <figure className={styles.imageCard} title={attachment.path}>
      <div className={styles.imageFrame}>
        {dataUrl ? (
          <ExpandableImage
            src={dataUrl}
            alt={attachment.name}
            title={attachment.name}
            imageClassName={styles.image}
            triggerClassName={styles.imageButton}
          />
        ) : (
          <span className={styles.imageStatus}>
            {unavailable ? 'Image unavailable' : 'Loading image…'}
          </span>
        )}
      </div>
      <figcaption className={styles.caption}>
        <span className={styles.captionName}>{attachment.name}</span>
        <span className={styles.fileSize}>{formatBytes(attachment.sizeBytes)}</span>
      </figcaption>
    </figure>
  )
}
