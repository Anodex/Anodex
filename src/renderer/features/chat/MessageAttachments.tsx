import { useEffect, useState } from 'react'
import type { ChatAttachment } from '@shared/chat.types'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import { formatBytes } from '../../lib/format'
import { loadAttachmentImage } from './loadAttachmentImage'
import { relocateMessageAttachment } from './relocateMessageAttachment'
import { updateImageVisionContext } from './visionContextAttachment'
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
  const [visionContextUpdating, setVisionContextUpdating] = useState(false)
  const [visionContextError, setVisionContextError] = useState('')

  // Keyed on the path, not the attachment object: the object identity changes
  // on every parent render, which re-ran this and re-read the file each time.
  const attachmentPath = attachment.path
  useEffect(() => {
    let cancelled = false
    setDataUrl(null)
    setUnavailable(false)
    void loadAttachmentImage(attachmentPath).then((result) => {
      if (cancelled) return
      setDataUrl(result)
      setUnavailable(result === null)
    })
    return () => {
      cancelled = true
    }
  }, [attachmentPath, attempt])

  const locate = async (): Promise<void> => {
    setLocating(true)
    setLocateError('')
    const result = await relocateMessageAttachment(messageId, attachment.path)
    if (result.status === 'error') setLocateError(result.message)
    setLocating(false)
  }

  const toggleVisionContext = async (): Promise<void> => {
    setVisionContextUpdating(true)
    setVisionContextError('')
    const result = await updateImageVisionContext(
      messageId,
      attachment.path,
      !attachment.visionContextPinned
    )
    if (result.status === 'error') setVisionContextError(result.message)
    setVisionContextUpdating(false)
  }

  // The picture, when there is one, stands on its own: no card border, no
  // caption bar, sized by its own aspect ratio. Name, size and the pin control
  // return on hover; the *pinned* state stays visible without hovering, since
  // an image silently entering later prompts is exactly what a user needs to
  // see. The framed box is kept only for the recovery path below, where there
  // is no picture for Retry and Locate file to sit on.
  if (dataUrl) {
    return (
      <figure className={styles.imageFigure} title={attachment.path}>
        <ExpandableImage
          src={dataUrl}
          alt={attachment.name}
          title={attachment.name}
          imageClassName={styles.image}
          triggerClassName={styles.imageButton}
        />
        {attachment.visionContextPinned && (
          <span className={styles.pinnedMark} aria-hidden="true">
            Kept
          </span>
        )}
        <figcaption className={styles.overlay}>
          <span className={styles.overlayName}>{attachment.name}</span>
          <span className={styles.overlaySize}>{formatBytes(attachment.sizeBytes)}</span>
          <button
            type="button"
            className={styles.overlayButton}
            onClick={() => void toggleVisionContext()}
            disabled={visionContextUpdating}
            title={
              attachment.visionContextPinned
                ? 'Stop including this image in later visual follow-ups'
                : 'Keep this image available for later visual follow-ups'
            }
          >
            {visionContextUpdating
              ? 'Saving…'
              : attachment.visionContextPinned
                ? 'Kept for follow-ups'
                : 'Keep for follow-ups'}
          </button>
        </figcaption>
        {visionContextError && (
          <span className={styles.visionContextError}>{visionContextError}</span>
        )}
      </figure>
    )
  }

  return (
    <figure className={styles.imageCard} title={attachment.path}>
      <div className={styles.imageFrame}>
        {
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
        }
      </div>
      <figcaption className={styles.caption}>
        <span className={styles.captionName}>{attachment.name}</span>
        <span className={styles.fileSize}>{formatBytes(attachment.sizeBytes)}</span>
      </figcaption>
    </figure>
  )
}
