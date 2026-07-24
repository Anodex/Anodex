import { useCallback, useEffect, useState } from 'react'
import type { VisualPreviewStorageUsage } from '@shared/visualPreview.types'
import { Icon } from '../../../../components/Icon'
import { Button } from '../../../../components/ui/Button'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { anodex } from '../../../../lib/anodex'
import { formatBytes } from '../../../../lib/format'
import pageStyles from '../../SettingsPage.module.css'
import styles from './VisualPreviewStorage.module.css'

export function VisualPreviewStorage(): JSX.Element {
  const [usage, setUsage] = useState<VisualPreviewStorageUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [status, setStatus] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    const result = await anodex.conversations.getVisualPreviewUsage()
    if (result.ok) {
      setUsage(result.value)
      setStatus('')
    } else {
      setStatus(result.error.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const clear = async (): Promise<void> => {
    setConfirmOpen(false)
    setClearing(true)
    const result = await anodex.conversations.clearVisualPreviews()
    if (result.ok) {
      setStatus(
        result.value.removedFiles === 0
          ? 'No visual previews were stored.'
          : `Cleared ${result.value.removedFiles} visual ${
              result.value.removedFiles === 1 ? 'preview' : 'previews'
            } (${formatBytes(result.value.removedBytes)}).`
      )
      const refreshed = await anodex.conversations.getVisualPreviewUsage()
      if (refreshed.ok) setUsage(refreshed.value)
    } else {
      setStatus(result.error.message)
    }
    setClearing(false)
  }

  const percent = usage ? Math.min(100, Math.round((usage.totalBytes / usage.limitBytes) * 100)) : 0

  return (
    <section className={pageStyles.section}>
      <div className={styles.heading}>
        <div>
          <h2 className={pageStyles.sectionTitle}>Visual preview storage</h2>
          <p className={pageStyles.sectionDesc}>
            Inspected and assistant-shown images stay outside chat JSON and are cleaned up
            automatically.
          </p>
        </div>
        <Button
          variant="danger"
          size="sm"
          iconLeft={<Icon name="trash" size={14} />}
          loading={clearing}
          disabled={loading || !usage?.fileCount}
          onClick={() => setConfirmOpen(true)}
        >
          Clear visual previews
        </Button>
      </div>

      <div className={styles.usageCard}>
        <div className={styles.usageLine}>
          <strong>{loading ? 'Checking storage…' : usageSummary(usage)}</strong>
          {usage && <span>{percent}% of automatic limit</span>}
        </div>
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Visual preview storage used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span className={styles.fill} style={{ width: `${percent}%` }} />
        </div>
        {usage && (
          <p className={styles.limitNote}>
            Automatic limits: {formatBytes(usage.conversationLimitBytes)} per conversation and{' '}
            {formatBytes(usage.limitBytes)} total. Oldest previews are removed first.
          </p>
        )}
        {status && (
          <p className={styles.status} role="status">
            {status}
          </p>
        )}
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title="Clear visual previews?"
          message="Conversations and messages will stay. Their stored screenshots and shown images will become unavailable."
          detail={usageSummary(usage)}
          confirmLabel="Clear previews"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void clear()}
        />
      )}
    </section>
  )
}

function usageSummary(usage: VisualPreviewStorageUsage | null): string {
  if (!usage || usage.fileCount === 0) return 'No visual previews stored'
  return `${formatBytes(usage.totalBytes)} · ${usage.fileCount} ${
    usage.fileCount === 1 ? 'preview' : 'previews'
  } across ${usage.conversationCount} ${
    usage.conversationCount === 1 ? 'conversation' : 'conversations'
  }`
}
