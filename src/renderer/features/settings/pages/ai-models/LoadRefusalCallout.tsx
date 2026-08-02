import type { EngineState } from '@shared/model.types'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import styles from './AiModelsSettings.module.css'

/**
 * A model load Anodex declined on its memory preflight, before the engine was
 * touched — see `RefusedModelLoad`.
 *
 * Deliberately NOT rendered as an engine error: the refusal changed nothing, so
 * the status pill in `EnginePanel` still tells the truth about what's loaded,
 * and this carries the whole story instead — what didn't load, why, what's
 * still running, and how to retry. The throw also surfaces as a toast at the
 * moment of the click; this is the copy that's still here a minute later, when
 * the user has closed some applications and comes back to act on it.
 *
 * Lives at page level rather than inside `EnginePanel` because the two ways to
 * provoke a refusal are on different sub-tabs: loading a model from **Models**,
 * and changing the context size or GPU split on **Advanced**, which reloads the
 * active model through `reloadActiveModelIfSafe`. Rendered inside the engine
 * panel, a refusal caused from Advanced left its own explanation on a tab the
 * user wasn't looking at.
 */
export function LoadRefusalCallout({
  engine,
  onRetry,
  onDismiss
}: {
  engine: EngineState
  onRetry: () => void
  onDismiss: () => void
}): JSX.Element | null {
  const refused = engine.refusedLoad
  if (!refused) return null
  const stillLoaded = engine.status === 'ready' && engine.model

  return (
    <div className={styles.refusalCallout}>
      <span className={styles.refusalIcon}>
        <Icon name="alert" size={16} />
      </span>
      <div className={styles.recText}>
        <strong>Didn&rsquo;t load {refused.model.name}</strong>
        <span>{refused.reason}</span>
        <span className={styles.refusalFootnote}>
          {stillLoaded
            ? `Nothing changed — ${engine.model?.name} is still loaded and ready to chat.`
            : 'Nothing changed — no model is loaded.'}
        </span>
      </div>
      <div className={styles.engineActions}>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
