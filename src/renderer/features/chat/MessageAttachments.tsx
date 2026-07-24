import { useEffect, useState } from 'react'
import type { ChatAttachment } from '@shared/chat.types'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import { formatBytes } from '../../lib/format'
import { loadAttachmentImage } from './loadAttachmentImage'
import { relocateMessageAttachment } from './relocateMessageAttachment'
import styles from './MessageAttachments.module.css'

export function MessageAttachments({
  attachments,
  messageId
}: {
  attachments: ChatAttachment[]
  messageId: string
}): JSX.Element {
  const images = attachments.filter((attachment) => attachment.kind === 'image')
  const files = attachments.filter((attachment) => attachment.kind !== 'image')

  return (
    <>
      {images.length > 0 && (
        <div className={styles.images}>
          {images.map((attachment) => (
            <InlineImageAttachment
              key={attachment.path}
              attachment={attachment}
              messageId={messageId}
            />
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

function InlineImageAttachment({
  attachment,
  messageId
}: {
  attachment: ChatAttachment
  messageId: string
}): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState('')

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
  }, [attachment, attempt])

  const locate = async (): Promise<void> => {
    setLocating(true)
    setLocateError('')
    const result = await relocateMessageAttachment(messageId, attachment.path)
    if (result.status === 'error') setLocateError(result.message)
    setLocating(false)
  }

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
          <div className={styles.imageStatus}>
            <span>{unavailable ? 'Image unavailable' : 'Loading image…'}</span>
            {unavailable && (
              <span className={styles.recoveryActions}>
                <button
                  type="button"
                  className={styles.recoveryButton}
                  onClick={() => setAttempt((value) => value + 1)}
                  aria-label={`Retry ${attachment.name}`}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className={styles.recoveryButton}
                  onClick={() => void locate()}
                  disabled={locating}
                  aria-label={`Locate file for ${attachment.name}`}
                >
                  {locating ? 'Locating…' : 'Locate file'}
                </button>
              </span>
            )}
            {locateError && <span className={styles.recoveryError}>{locateError}</span>}
          </div>
        )}
      </div>
      <figcaption className={styles.caption}>
        <span className={styles.captionName}>{attachment.name}</span>
        <span className={styles.fileSize}>{formatBytes(attachment.sizeBytes)}</span>
      </figcaption>
    </figure>
  )
}
