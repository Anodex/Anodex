import type { ComposerAttachment } from '../../../lib/attachments'
import { FileTypeIcon } from '../../../components/FileTypeIcon'
import { Icon } from '../../../components/Icon'
import { formatBytes } from '../../../lib/format'
import styles from '../ChatComposer.module.css'

interface ComposerAttachmentsProps {
  attachments: ComposerAttachment[]
  onRemove: (path: string) => void
}

/** Renders the files staged for the next chat message. */
export function ComposerAttachments({
  attachments,
  onRemove
}: ComposerAttachmentsProps): JSX.Element | null {
  if (attachments.length === 0) return null

  return (
    <div className={styles.attachments}>
      {attachments.map((attachment) => (
        <div key={attachment.path} className={styles.attachment} title={attachment.path}>
          {attachment.kind === 'image' ? (
            <img className={styles.attachmentThumbnail} src={attachment.dataUrl} alt="" />
          ) : (
            <FileTypeIcon fileName={attachment.name} size={13} />
          )}
          <span className={styles.attachmentName}>{attachment.name}</span>
          <span className={styles.attachmentSize}>{formatBytes(attachment.sizeBytes)}</span>
          <button
            type="button"
            className={styles.attachmentRemove}
            onClick={() => onRemove(attachment.path)}
            aria-label={`Remove ${attachment.name}`}
            title="Remove"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}
