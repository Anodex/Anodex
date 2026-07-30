import { useModelStore } from '../../stores/modelStore'
import { Overlay } from '../../components/ui/Overlay'
import { Icon } from '../../components/Icon'
import styles from './SafeModeDialog.module.css'

/**
 * The escape hatch from a model that crashes the app while loading.
 *
 * Shown only when the previous run left a crash sentinel behind (see
 * `main/llama/loadSentinel.ts`), and only in place of the automatic model
 * restore — that restore is what would otherwise reproduce the crash on every
 * launch, with the app dying before any window could offer a way out.
 *
 * Blocking is the right shape here despite the cost: the choice decides
 * whether a model loads at all this session, it is rare by construction, and
 * every dismissal path simply leaves the engine unloaded, which is safe.
 */
export function SafeModeDialog(): JSX.Element | null {
  const recovery = useModelStore((s) => s.loadRecovery)
  const retrySafely = useModelStore((s) => s.retryLoadSafely)
  const retryUnchanged = useModelStore((s) => s.retryLoadUnchanged)
  const dismiss = useModelStore((s) => s.dismissLoadRecovery)

  if (!recovery) return null

  const { interrupted } = recovery
  const offload =
    interrupted.gpuLayers === 'auto' ? 'automatic' : `${interrupted.gpuLayers} layer(s)`

  return (
    <Overlay onClose={dismiss} ariaLabel={recovery.headline} cardClassName={styles.modal}>
      <div className={styles.header}>
        <span className={styles.badge}>
          <Icon name="alert" size={16} />
        </span>
        <div>
          <div className={styles.title}>{recovery.headline}</div>
          <div className={styles.subtitle}>{recovery.explanation}</div>
        </div>
      </div>

      <dl className={styles.detail}>
        <dt>Model</dt>
        <dd>{interrupted.modelName}</dd>
        <dt>GPU offload</dt>
        <dd>{offload}</dd>
        {interrupted.contextSize !== undefined && (
          <>
            <dt>Context</dt>
            <dd>{interrupted.contextSize.toLocaleString()} tokens</dd>
          </>
        )}
      </dl>

      <p className={styles.note}>
        {recovery.alreadyCpuOnly
          ? 'Nothing loads automatically until you choose.'
          : 'Choosing the safer retry also saves these settings, so the next launch starts the same way.'}
      </p>

      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={dismiss}>
          Not now
        </button>
        <button type="button" className={styles.secondary} onClick={() => void retryUnchanged()}>
          Load unchanged
        </button>
        <button type="button" className={styles.primary} onClick={() => void retrySafely()}>
          <Icon name="cpu" size={15} />
          {recovery.retryLabel}
        </button>
      </div>
    </Overlay>
  )
}
