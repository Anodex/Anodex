import { useState } from 'react'
import type { BackupResult } from '@shared/backup.types'
import { Icon } from '../../../../components/Icon'
import { Button } from '../../../../components/ui/Button'
import { anodex } from '../../../../lib/anodex'
import { notifyError } from '../../../../stores/uiStore'
import pageStyles from '../../SettingsPage.module.css'
import styles from './BackupSection.module.css'

/**
 * Copy every store to a folder of the user's choosing.
 *
 * The insurance policy for a local-first app: all of this data lives on one
 * machine, and a bad migration or a dead disk is otherwise the end of it.
 * Deliberately a plain folder copy rather than an archive — it can be
 * restored by hand with the app closed, which is the property that matters
 * when the app itself is the thing that broke.
 */
export function BackupSection(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BackupResult | null>(null)

  const runBackup = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await anodex.backup.backupData()
      if (!response.ok) {
        notifyError('Backup failed', response.error.detail ?? response.error.message)
        return
      }
      // Null means the folder picker was cancelled.
      if (response.value) setResult(response.value)
    } finally {
      setBusy(false)
    }
  }

  const skippedWeights = result?.skipped.some((entry) => entry.reason === 'redownloadable')

  return (
    <section className={pageStyles.section}>
      <div className={styles.head}>
        <div>
          <h2 className={pageStyles.sectionTitle}>Back up your data</h2>
          <p className={pageStyles.sectionDesc}>
            Copies your chats, projects, memory, skills, scheduled tasks and settings into a dated
            folder. Nothing is moved or deleted, so this is safe to run at any time.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          iconLeft={<Icon name="download" size={15} />}
          onClick={() => void runBackup()}
        >
          {busy ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>

      <ul className={styles.notes}>
        <li>
          Downloaded models are <strong>not</strong> included — they are gigabytes each and can be
          downloaded again for free.
        </li>
        <li>
          API keys and mailbox logins are encrypted by this computer, so a backup restored on a
          different machine will need those entered again.
        </li>
        <li>
          To restore: close Anodex, then copy the folder&apos;s contents back over your data
          directory.
        </li>
      </ul>

      {result && (
        <div className={styles.result}>
          <Icon name="check" size={15} />
          <div className={styles.resultText}>
            <strong>
              Backed up {result.copied.length} {result.copied.length === 1 ? 'store' : 'stores'}
            </strong>
            <span className={styles.path}>{result.path}</span>
            {skippedWeights && <span className={styles.note}>Downloaded models were skipped.</span>}
          </div>
          <button
            type="button"
            className={styles.reveal}
            onClick={() => void anodex.backup.revealPath(result.path)}
          >
            Show folder
          </button>
        </div>
      )}
    </section>
  )
}
