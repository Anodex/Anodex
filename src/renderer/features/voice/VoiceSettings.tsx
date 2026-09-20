import { reasonFor } from '@shared/result'
import { useCallback, useEffect, useState } from 'react'
import type { VoiceReadiness } from '@shared/ipc'
import { anodex } from '../../lib/anodex'
import { Button } from '../../components/ui/Button'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { notifyError } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { SettingRow } from '../settings/SettingRow'
import { ToggleControl } from '../settings/controls'
import pageStyles from '../settings/SettingsPage.module.css'
import { VOICE_NAME } from './voiceIdentity'
import { forgetVoiceReadiness } from './readAloud'
import styles from './VoiceSettings.module.css'

/**
 * The Voice page.
 *
 * Two decisions live here and they are deliberately separate: whether Arc may
 * speak, and whether the 2.3 GB that lets him is on this machine. Collapsing
 * them into one switch would mean turning voice off to reclaim the space, or
 * re-downloading a model to try the feature again — and a toggle that silently
 * costs two gigabytes is not a toggle.
 */

const gigabytes = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(2)} GB`

export function VoiceSettings(): JSX.Element {
  const enabled = useSettingsStore((s) => s.settings?.voice?.enabled ?? false)
  const update = useSettingsStore((s) => s.update)

  const [readiness, setReadiness] = useState<VoiceReadiness | null>(null)
  const [received, setReceived] = useState<number | null>(null)
  const [removing, setRemoving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    // The answer is cached for the window, and this page is the one place it can
    // become wrong — downloading is what makes it wrong.
    forgetVoiceReadiness()
    setReadiness(await anodex.voice.available())
  }, [])

  useEffect(() => {
    void refresh()
    return anodex.voice.onDownloadProgress((progress) => {
      setReceived(progress.receivedBytes)
    })
  }, [refresh])

  const downloading = received !== null || readiness?.downloading === true
  const total = readiness?.modelBytes ?? 0
  const present = readiness?.modelBytesPresent ?? 0
  const percent = total > 0 ? Math.min(100, Math.round(((received ?? present) / total) * 100)) : 0

  const startDownload = async (): Promise<void> => {
    setReceived(0)
    const result = await anodex.voice.download()
    setReceived(null)
    if (!result.ok) {
      // Cancelling is a decision, not a failure, and does not deserve a toast.
      if (result.error.code !== 'voice.download-cancelled') notifyError(reasonFor(result.error))
      void refresh()
      return
    }
    // Turn it on, because pressing "Download Arc's voice" and waiting ten
    // minutes *is* the decision — leaving the switch off afterwards would end a
    // long wait with nothing visibly different, and send somebody hunting for
    // the step they missed. This is not a feature switching itself on because a
    // file appeared; it is the request being finished.
    if (!enabled) await update({ voice: { enabled: true } })
    void refresh()
  }

  const remove = async (): Promise<void> => {
    setRemoving(true)
    const result = await anodex.voice.removeModel()
    setRemoving(false)
    setConfirmRemove(false)
    if (!result.ok) notifyError(reasonFor(result.error))
    void refresh()
  }

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Assistant</p>
        <h1 className={pageStyles.pageTitle}>Voice</h1>
        <p className={pageStyles.pageDesc}>
          {VOICE_NAME} can read a finished reply aloud. Everything happens on this computer —
          nothing is sent anywhere to be spoken.
        </p>
      </header>

      <section className={pageStyles.section}>
        <SettingRow
          label={`Let ${VOICE_NAME} speak`}
          description={
            !readiness?.modelReady
              ? `Needs ${VOICE_NAME}'s voice downloaded below.`
              : enabled
                ? 'A Listen button appears under every finished reply.'
                : 'Turn this on for a Listen button under every finished reply.'
          }
          control={
            <ToggleControl
              checked={enabled}
              onChange={(next) => {
                void update({ voice: { enabled: next } })
              }}
              ariaLabel={`Let ${VOICE_NAME} speak`}
            />
          }
        />
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>{VOICE_NAME}&rsquo;s voice</h2>
        <p className={pageStyles.sectionDesc}>
          The model that speaks, {gigabytes(total)}, kept on this computer. It is not part of the
          installer because most people will never turn this on, and a download you chose is better
          than one you carried.
        </p>

        {downloading ? (
          <div className={styles.progress}>
            <div className={styles.bar}>
              <div className={styles.fill} style={{ width: `${percent}%` }} />
            </div>
            <div className={styles.progressText}>
              <span>
                {gigabytes(received ?? 0)} of {gigabytes(total)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void anodex.voice.cancelDownload()
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : readiness?.modelReady ? (
          <div className={styles.installed}>
            <span className={styles.installedText}>
              Installed — {gigabytes(present)} on this computer.
            </span>
            <Button
              variant="danger"
              size="sm"
              loading={removing}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </Button>
          </div>
        ) : (
          <Button variant="primary" onClick={() => void startDownload()}>
            Download {VOICE_NAME}&rsquo;s voice ({gigabytes(total)})
          </Button>
        )}
      </section>

      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${VOICE_NAME}'s voice?`}
          message={`This frees ${gigabytes(present)}. ${VOICE_NAME} stops speaking until it is downloaded again — the setting above is left alone.`}
          confirmLabel="Remove"
          icon="speaker"
          onConfirm={() => void remove()}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </div>
  )
}
