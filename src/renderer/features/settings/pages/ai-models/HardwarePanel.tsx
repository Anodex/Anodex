import type { CSSProperties } from 'react'
import type { HardwareInfo } from '@shared/system.types'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { Spinner } from '../../../../components/ui/Spinner'
import { hardwareFitLabel, scoreHardwareProfile } from './scoring'
import styles from './AiModelsSettings.module.css'

/** Detected hardware specs and a 0-100 fit score for this computer. */
export function HardwarePanel({
  hardware,
  loading,
  onRedetect
}: {
  hardware: HardwareInfo | null
  loading: boolean
  onRedetect: () => void
}): JSX.Element {
  const hardwareScore = hardware ? scoreHardwareProfile(hardware) : null
  const fit = hardware ? hardwareFitLabel(hardware) : null

  return (
    <section className={styles.sectionFlush}>
      <div className={styles.sectionTitleRow}>
        <div>
          <p className={styles.sectionKicker}>Computer hardware</p>
          <h2 className={styles.sectionTitle}>Recommendation profile</h2>
          <p className={styles.sectionDesc}>
            Anodex uses this profile to decide which local models should run well.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Icon name="refresh" size={14} />}
          onClick={onRedetect}
        >
          Re-detect
        </Button>
      </div>

      <div className={styles.hardwarePanel}>
        {loading || !hardware ? (
          <div className={styles.hardwareLoading}>
            <Spinner size={16} />
            <span>Detecting hardware…</span>
          </div>
        ) : (
          <>
            <div className={styles.hardwareSummary}>
              <div className={styles.hardwareHeadline}>
                <div>
                  <h3 className={styles.hardwareTitle}>This computer</h3>
                  <p className={styles.hardwareSubtitle}>{fit}</p>
                </div>
                <div
                  className={styles.hardwareScore}
                  style={{ '--score': `${hardwareScore ?? 0}%` } as CSSProperties}
                  aria-label={`Hardware score ${hardwareScore ?? 0} out of 100`}
                >
                  <span>{hardwareScore ?? 0}</span>
                </div>
              </div>

              <div className={styles.hardwareGrid}>
                <Spec label="CPU" value={hardware.cpu} />
                <Spec label="Cores" value={String(hardware.cores)} />
                <Spec label="RAM" value={hardware.ram} />
                <Spec label="GPU" value={hardware.gpu ?? 'Not detected'} />
                <Spec label="GPU driver" value={hardware.gpuDriver ?? 'Not detected'} />
                <Spec label="VRAM" value={hardware.vram ?? 'Not detected'} />
                <Spec label="Free storage" value={hardware.storageFree ?? 'Unknown'} />
                <Spec label="OS" value={hardware.os} />
              </div>
            </div>

            {/* One recommendation, not two. This panel used to carry its own
                "we suggest X" callout beside the specs, directly above a strip
                whose whole job is recommending models for this computer -- and
                the two were scored differently, so they could disagree. */}
            <div className={styles.hardwareReasons}>
              <div className={styles.hintLine}>
                <span className={styles.hintDot} />
                Scores are based on RAM, VRAM, quant size, model size, and expected local coding
                workload.
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function Spec({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className={styles.spec}>
      <div className={styles.specLabel}>{label}</div>
      <div className={styles.specValue} title={value}>
        {value}
      </div>
    </div>
  )
}
