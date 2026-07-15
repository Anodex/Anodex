import type { EngineState } from '@shared/model.types'
import type { HardwareInfo } from '@shared/system.types'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import { computeReliabilityScore } from '@shared/modelReliability.types'
import { Icon } from '../../../../components/Icon'
import { scoreInstalledModel } from './scoring'
import styles from './AiModelsSettings.module.css'

export function CompatibilitySummary({
  engine,
  hardware,
  reliability
}: {
  engine: EngineState
  hardware: HardwareInfo | null
  reliability: Map<string, ModelReliabilityRecord>
}): JSX.Element {
  const model = engine.model
  const fit = model && hardware ? scoreInstalledModel(model, hardware) : null
  const reliabilityScore = model ? computeReliabilityScore(reliability.get(model.id)) : null
  const overall = fit
    ? reliabilityScore === null
      ? fit.score
      : Math.round(fit.score * 0.55 + reliabilityScore * 0.35 + 10)
    : null

  return (
    <section className={styles.section}>
      <div className={styles.sectionTitleRow}>
        <div>
          <h2 className={styles.sectionTitle}>Active model compatibility</h2>
          <p className={styles.sectionDesc}>
            Hardware fit, runtime support, and observed tool behavior are scored separately.
          </p>
        </div>
        {overall !== null && (
          <span className={styles.compatibilityTotal}>
            <strong>{overall}</strong> / 100 overall
          </span>
        )}
      </div>

      {!model ? (
        <div className={styles.compatibilityEmpty}>
          <Icon name="models" size={20} />
          <div>
            <strong>Load a local model to see compatibility</strong>
            <p>Hardware fit and runtime details will appear here after the model loads.</p>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.compatibilitySignals}>
            <CompatibilitySignal
              label="Hardware fit"
              score={fit?.score ?? null}
              progress={fit?.score ?? 0}
              description={
                fit
                  ? `${fit.fit} fit for the detected RAM, VRAM, model size, and quantization.`
                  : 'Waiting for hardware detection.'
              }
            />
            <CompatibilitySignal
              label="Tool reliability"
              score={reliabilityScore}
              progress={reliabilityScore ?? 0}
              description={
                reliabilityScore === null
                  ? 'A score appears after at least three observed tool outcomes.'
                  : 'Based on real tool-call outcomes for this model on this computer.'
              }
            />
            <CompatibilitySignal
              label="Runtime support"
              score="Full"
              progress={100}
              description="GGUF format is supported by the local Llama engine."
            />
          </div>

          <div className={styles.compatibilityFacts}>
            <div>
              <span>Requested context</span>
              <strong>{engine.contextSize?.toLocaleString() ?? '—'} tokens</strong>
            </div>
            <div>
              <span>GPU offload</span>
              <strong>
                {engine.gpuLayersUsed !== undefined && engine.gpuLayersTotal !== undefined
                  ? `${engine.gpuLayersUsed} / ${engine.gpuLayersTotal} layers`
                  : 'Not reported'}
              </strong>
            </div>
            <div>
              <span>Quantization</span>
              <strong>{model.quant ?? 'Unknown'}</strong>
            </div>
            <div>
              <span>Engine state</span>
              <strong>{engine.status === 'ready' ? 'Ready' : engine.status}</strong>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function CompatibilitySignal({
  label,
  score,
  progress,
  description
}: {
  label: string
  score: number | string | null
  progress: number
  description: string
}): JSX.Element {
  return (
    <article className={styles.compatibilitySignal}>
      <div className={styles.compatibilitySignalTop}>
        <span>{label}</span>
        <strong>{score ?? '—'}</strong>
      </div>
      <div className={styles.compatibilityTrack}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <p>{description}</p>
    </article>
  )
}
