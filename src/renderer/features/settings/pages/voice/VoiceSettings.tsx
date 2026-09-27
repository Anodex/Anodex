import { useEffect, useState } from 'react'
import { reasonFor } from '@shared/result'
import type { SpeechVoice } from '@shared/settings.types'
import { anodex } from '../../../../lib/anodex'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { notifyError } from '../../../../stores/uiStore'
import { Button } from '../../../../components/ui/Button'
import { SettingRow } from '../../SettingRow'
import { SelectControl, ToggleControl } from '../../controls'
import { forgetSpeechReadiness, stopReadAloud } from '../../../voice/readAloud'
import pageStyles from '../../SettingsPage.module.css'
import styles from './VoiceSettings.module.css'

const formatSize = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(2)} GB`
const BUILT_IN_VOICES: Array<{ value: SpeechVoice; label: string }> = [
  { value: 'serena', label: 'Serena' },
  { value: 'vivian', label: 'Vivian' },
  { value: 'uncle_fu', label: 'Uncle Fu' },
  { value: 'ryan', label: 'Ryan' },
  { value: 'aiden', label: 'Aiden' },
  { value: 'ono_anna', label: 'Ono Anna' },
  { value: 'sohee', label: 'Sohee' },
  { value: 'eric', label: 'Eric' },
  { value: 'dylan', label: 'Dylan' }
]
const SPEED_OPTIONS = [
  { value: '0.75', label: '0.75×' },
  { value: '0.9', label: '0.9×' },
  { value: '1', label: 'Normal' },
  { value: '1.1', label: '1.1×' },
  { value: '1.25', label: '1.25×' },
  { value: '1.5', label: '1.5×' }
]

export function VoiceSettings(): JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const [status, setStatus] = useState<{
    runtimeAvailable: boolean
    pocketAvailable: boolean
    modelInstalled: boolean
    referenceReady: boolean
    engineReady: boolean
    downloadBytes: number
  } | null>(null)
  const [received, setReceived] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [warming, setWarming] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [pocketVoices, setPocketVoices] = useState<Array<{ id: string; name: string }>>([])

  const refresh = async (): Promise<void> => {
    const next = await anodex.speech.status()
    setStatus(next)
    if (useSettingsStore.getState().settings?.speech.engine === 'pocket' && next.runtimeAvailable) {
      const voices = await anodex.speech.listVoices()
      if (voices.ok) setPocketVoices(voices.value)
    }
  }
  useEffect(() => {
    void refresh()
    void anodex.speech.getTranscript().then(setTranscript)
    return anodex.speech.onProgress((progress) => setReceived(progress.receivedBytes))
  }, [])

  if (!settings) return <div className={pageStyles.page} />
  const speech = settings.speech
  const prepare = async (quiet = false): Promise<void> => {
    setWarming(true)
    const result = await anodex.speech.prepare()
    setWarming(false)
    if (!result.ok && (!quiet || useSettingsStore.getState().settings?.speech.enabled))
      notifyError('Could not prepare speech', reasonFor(result.error))
    forgetSpeechReadiness()
    await refresh()
  }
  const download = async (): Promise<void> => {
    setBusy(true)
    setReceived(0)
    const result = await anodex.speech.download()
    setBusy(false)
    setReceived(null)
    if (!result.ok && result.error.code !== 'speech.download-cancelled')
      notifyError('Could not download the speech model', reasonFor(result.error))
    forgetSpeechReadiness()
    await refresh()
    if (result.ok && useSettingsStore.getState().settings?.speech.enabled) await prepare(true)
  }
  const chooseReference = async (): Promise<void> => {
    stopReadAloud()
    const result = await anodex.speech.chooseReference()
    if (!result.ok) {
      notifyError('Could not use that recording', reasonFor(result.error))
      return
    }
    if (!result.value) return
    await update({ speech: { voice: 'personal' } })
    setTranscript('')
    forgetSpeechReadiness()
    await refresh()
    if (speech.enabled) {
      const selectedStatus = await anodex.speech.status()
      if (selectedStatus.modelInstalled && selectedStatus.runtimeAvailable) await prepare(true)
    }
  }
  const saveTranscript = async (): Promise<void> => {
    const result = await anodex.speech.setTranscript(transcript)
    if (!result.ok) notifyError('Could not save the recording transcript', reasonFor(result.error))
    forgetSpeechReadiness()
    await refresh()
  }
  const removeReference = async (): Promise<void> => {
    stopReadAloud()
    try {
      await anodex.speech.removeReference()
    } catch (error) {
      notifyError(
        'Could not remove the recording',
        error instanceof Error ? error.message : 'The request failed.'
      )
      return
    }
    if (speech.voice === 'personal') await update({ speech: { voice: 'default' } })
    setTranscript('')
    forgetSpeechReadiness()
    await refresh()
  }

  const modelBytes = status?.downloadBytes ?? 1_283_766_112
  const progress = Math.min(100, Math.round(((received ?? 0) / modelBytes) * 100))
  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Assistant</p>
        <h1 className={pageStyles.pageTitle}>Voice</h1>
        <p className={pageStyles.pageDesc}>
          Have Anodex read finished replies in a built-in voice or your own. Recordings stay on this
          computer.
        </p>
      </header>

      <section className={pageStyles.section}>
        <SettingRow
          label="Enable read aloud"
          description="Adds a Listen button to completed replies and keeps speech ready while Anodex is open. It stays off until you turn it on."
          control={
            <ToggleControl
              checked={speech.enabled}
              onChange={(enabled) => {
                void (async () => {
                  await update({ speech: { enabled } })
                  if (!enabled) {
                    stopReadAloud()
                    setWarming(false)
                    await anodex.speech.release()
                  } else {
                    const currentStatus = status ?? (await anodex.speech.status())
                    setStatus(currentStatus)
                    if (currentStatus.modelInstalled && currentStatus.runtimeAvailable)
                      await prepare(true)
                  }
                  await refresh()
                })()
              }}
              ariaLabel="Enable read aloud"
            />
          }
        />
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Speech engine</h2>
        <label className={styles.voiceChoice}>
          <span>Engine</span>
          <SelectControl
            value={speech.engine}
            disabled={busy || warming}
            options={[
              { value: 'qwen', label: 'Qwen' },
              ...(status?.pocketAvailable || speech.engine === 'pocket'
                ? [{ value: 'pocket', label: 'Pocket (local trial)' }]
                : [])
            ]}
            onChange={(value) => {
              stopReadAloud()
              void (async () => {
                await anodex.speech.release()
                await update({ speech: { engine: value as 'qwen' | 'pocket' } })
                forgetSpeechReadiness()
                await refresh()
                const selected = await anodex.speech.status()
                if (speech.enabled && selected.runtimeAvailable && selected.modelInstalled)
                  await prepare(true)
              })()
            }}
          />
        </label>
      </section>

      {speech.engine === 'qwen' && (
        <section className={pageStyles.section}>
          <h2 className={pageStyles.sectionTitle}>Local speech model</h2>
          <p className={pageStyles.sectionDesc}>
            Choose the Base model for its default voice or your recording. The CustomVoice model has
            nine built-in speakers. Each downloads separately and shares a tokenizer; only one loads
            into memory at a time. Speech runs on the CPU, separately from the chat model.
          </p>
          <label className={styles.voiceChoice}>
            <span>Model and voice</span>
            <SelectControl
              value={speech.voice}
              disabled={busy || warming}
              options={[
                { value: 'default', label: 'Base · Default voice' },
                ...(status?.referenceReady
                  ? [{ value: 'personal', label: 'Base · My recording' }]
                  : []),
                ...BUILT_IN_VOICES.map(({ value, label }) => ({
                  value,
                  label: `CustomVoice · ${label}`
                }))
              ]}
              onChange={(value) => {
                const voice = value as SpeechVoice
                stopReadAloud()
                void (async () => {
                  await update({ speech: { voice } })
                  forgetSpeechReadiness()
                  const selectedStatus = await anodex.speech.status()
                  setStatus(selectedStatus)
                  if (
                    speech.enabled &&
                    selectedStatus.modelInstalled &&
                    selectedStatus.runtimeAvailable
                  )
                    await prepare(true)
                })()
              }}
            />
          </label>
          {!status?.runtimeAvailable && (
            <p className={styles.note}>
              This build is missing the local speech runtime. Rebuild Anodex after preparing it.
            </p>
          )}
          {status?.modelInstalled ? (
            <p className={styles.note}>
              Selected speech model installed locally ({formatSize(modelBytes)}).
            </p>
          ) : busy ? (
            <div className={styles.download}>
              <progress max={100} value={progress} aria-label="Speech model download progress" />
              <span>
                {formatSize(received ?? 0)} of {formatSize(modelBytes)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void anodex.speech.cancelDownload()}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              disabled={!status?.runtimeAvailable}
              onClick={() => void download()}
            >
              Download selected model ({formatSize(modelBytes)})
            </Button>
          )}
        </section>
      )}

      {speech.engine === 'pocket' && (
        <section className={pageStyles.section}>
          <h2 className={pageStyles.sectionTitle}>Pocket voice</h2>
          <p className={pageStyles.sectionDesc}>
            This local trial uses the separate Anodex Voice prototype. The first preparation may
            download Pocket&apos;s model. Your saved custom voices remain on this computer.
          </p>
          <label className={styles.voiceChoice}>
            <span>Voice</span>
            <SelectControl
              value={speech.pocketVoice}
              disabled={warming || !status?.runtimeAvailable}
              options={[
                ...(!pocketVoices.some((voice) => voice.id === speech.pocketVoice)
                  ? [{ value: speech.pocketVoice, label: 'Saved voice unavailable' }]
                  : []),
                ...pocketVoices.map((voice) => ({ value: voice.id, label: voice.name }))
              ]}
              onChange={(voice) => {
                stopReadAloud()
                void (async () => {
                  await update({ speech: { pocketVoice: voice } })
                  if (speech.enabled) await prepare(true)
                })()
              }}
            />
          </label>
          {!status?.runtimeAvailable && (
            <p className={styles.note}>
              Install the Anodex Voice prototype beside this development checkout to try Pocket.
            </p>
          )}
        </section>
      )}

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Voice</h2>
        <label className={styles.voiceChoice}>
          <span>Playback speed</span>
          <SelectControl
            value={String(speech.speed)}
            options={SPEED_OPTIONS}
            onChange={(value) => void update({ speech: { speed: Number(value) } })}
          />
          <span>Speeds other than Normal also change pitch.</span>
        </label>
        {speech.engine === 'qwen' && (
          <>
            <p className={pageStyles.sectionDesc}>
              Built-in voices need no recording. You can also add your own voice to the Base model.
              Speech generation and recordings stay on this computer.
            </p>
            <p className={styles.note}>
              {speech.voice === 'personal'
                ? 'Your recording is selected.'
                : status?.referenceReady
                  ? 'Your recording is saved locally. Select “My recording” above to use it.'
                  : 'No recording is needed for the built-in voices.'}
            </p>
            <div className={styles.reference}>
              <div className={styles.actions}>
                <Button size="sm" onClick={() => void chooseReference()}>
                  {status?.referenceReady ? 'Replace my recording' : 'Use my own voice'}
                </Button>
                {status?.referenceReady && (
                  <Button size="sm" variant="ghost" onClick={() => void removeReference()}>
                    Remove my recording
                  </Button>
                )}
              </div>
            </div>
            {status?.referenceReady && (
              <>
                <label className={styles.transcript}>
                  <span>Words in the recording (optional)</span>
                  <textarea
                    value={transcript}
                    maxLength={1000}
                    rows={3}
                    placeholder="Type the exact words spoken in the recording for a closer voice match."
                    onChange={(event) => setTranscript(event.currentTarget.value)}
                  />
                </label>
                <Button size="sm" variant="ghost" onClick={() => void saveTranscript()}>
                  Save transcript
                </Button>
              </>
            )}
          </>
        )}
        {status?.modelInstalled && (
          <div className={styles.prepare}>
            <span className={styles.note}>
              {warming
                ? 'Loading the speech model into memory for quicker listening…'
                : status.engineReady
                  ? 'Speech is loaded and ready for quick playback.'
                  : 'Enabling read aloud prepares speech automatically. It stays loaded until read aloud is turned off or Anodex closes.'}
            </span>
            {!status.engineReady && (
              <Button size="sm" loading={warming} onClick={() => void prepare()}>
                Prepare speech
              </Button>
            )}
            {status.engineReady && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  stopReadAloud()
                  void anodex.speech.release().then(refresh)
                }}
              >
                Unload speech model
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
