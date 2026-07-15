import type { EngineState, ModelSettingsRecommendation } from '@shared/model.types'
import { inferModelFamily } from '@shared/recommendedModels'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { ModelLogo } from '../../../../components/ModelLogo'
import { Spinner } from '../../../../components/ui/Spinner'
import styles from './AiModelsSettings.module.css'

/** The active local model, its status, and quick engine-level actions. */
export function EnginePanel({
  engine,
  modelCount,
  contextSize,
  gpuLayers,
  fileRecommendation,
  recommendingFile,
  onAddModel,
  onOpenModelsFolder,
  onUnload,
  onRecommendForModel,
  onApplyFileRecommendation,
  onDismissFileRecommendation
}: {
  engine: EngineState
  modelCount: number
  contextSize: number
  gpuLayers: number | 'auto'
  fileRecommendation: ModelSettingsRecommendation | null
  recommendingFile: boolean
  onAddModel: () => void
  onOpenModelsFolder: () => void
  onUnload: () => void
  onRecommendForModel: () => void
  onApplyFileRecommendation: () => void
  onDismissFileRecommendation: () => void
}): JSX.Element {
  const loaded = engine.status === 'ready' && engine.model
  const loading = engine.status === 'loading'
  const statusLabel = loading
    ? 'Loading'
    : loaded
      ? 'Loaded'
      : engine.status === 'error'
        ? 'Error'
        : 'Unloaded'

  return (
    <section className={styles.sectionFlush}>
      <div className={styles.sectionTitleRow}>
        <div>
          <p className={styles.sectionKicker}>Local engine</p>
          <h2 className={styles.sectionTitle}>Built-in Llama runtime</h2>
          <p className={styles.sectionDesc}>
            The active model Anodex will use for chat and coding.
          </p>
        </div>
      </div>

      <div className={styles.enginePanel}>
        <div className={styles.engineMain}>
          <div className={styles.engineIdentity}>
            <div className={styles.engineChip}>
              {loading ? (
                <Spinner size={18} variant="hex" />
              ) : engine.model ? (
                <ModelLogo family={inferModelFamily(engine.model.name)} size={20} />
              ) : (
                <Icon name="cpu" size={20} />
              )}
            </div>
            <div className={styles.engineTitleBlock}>
              <div className={styles.engineTitleRow}>
                <h3 className={styles.engineName}>{engine.model?.name ?? 'No model loaded'}</h3>
                <span className={`${styles.statusPill} ${styles[`status${statusLabel}`]}`}>
                  <span className={styles.statusDot} />
                  {statusLabel}
                </span>
              </div>
              <div
                className={styles.enginePath}
                title={engine.model?.path ?? 'Add or load a GGUF model'}
              >
                {engine.model?.path ??
                  'Add a .gguf file, then load the model you want Anodex to use.'}
              </div>
              {engine.error && <p className={styles.errorText}>{engine.error}</p>}
            </div>
          </div>

          <div className={styles.engineActions}>
            {/* Gated on `source === 'local'` — reading GGUF metadata only
                makes sense for a real local file. A future cloud model has
                nothing here to analyze, so this naturally disappears for one
                without needing special-casing once that source exists. */}
            {loaded && engine.model?.source === 'local' && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Icon name="sparkle" size={14} />}
                onClick={onRecommendForModel}
                disabled={recommendingFile}
              >
                {recommendingFile ? 'Analyzing…' : 'Recommend settings'}
              </Button>
            )}
            {loaded && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Icon name="power" size={14} />}
                onClick={onUnload}
              >
                Unload
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Icon name="plus" size={14} />}
              onClick={onAddModel}
            >
              Add GGUF
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<Icon name="folder" size={14} />}
              onClick={onOpenModelsFolder}
            >
              Models folder
            </Button>
          </div>
        </div>

        {fileRecommendation && (
          <div className={styles.recommendationCallout}>
            <span className={styles.recIcon}>
              <Icon name="sparkle" size={16} />
            </span>
            <div className={styles.recText}>
              <strong>Recommended for this model</strong>
              <span>{fileRecommendation.rationale}</span>
            </div>
            <div className={styles.engineActions}>
              <Button variant="secondary" size="sm" onClick={onApplyFileRecommendation}>
                Apply
              </Button>
              <Button variant="ghost" size="sm" onClick={onDismissFileRecommendation}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        <div className={styles.engineMetrics}>
          <Metric
            label="Context"
            value={
              engine.contextSize
                ? `${engine.contextSize.toLocaleString()} tokens`
                : `${contextSize.toLocaleString()} target`
            }
          />
          <Metric
            label="GPU mode"
            value={
              gpuLayers === 'auto' ? 'Auto' : gpuLayers === 0 ? 'CPU only' : `Custom (${gpuLayers})`
            }
          />
          <Metric label="Installed" value={`${modelCount} model${modelCount === 1 ? '' : 's'}`} />
          <Metric label="Engine" value="Built-in Llama" />
        </div>
      </div>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className={styles.metric}>
      <div className={styles.metricLabel}>{label}</div>
      <div className={styles.metricValue}>{value}</div>
    </div>
  )
}
