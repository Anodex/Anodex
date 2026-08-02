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
/**
 * The reassurance line: what is still running, given that the refused load
 * changed nothing.
 *
 * Three cases, because naming the model unconditionally reads badly in the most
 * common one. Raising the context size on the model that is *already* loaded
 * reloads it, so a refusal there has the refused model and the live model being
 * the same file — "Didn't load X … X is still loaded" is accurate but parses as
 * a contradiction. That case says what actually differs instead: the size it is
 * still running at.
 */
function describeWhatSurvived(engine: EngineState): string {
  const loaded = engine.status === 'ready' ? engine.model : undefined
  if (!loaded) return 'Nothing changed — no model is loaded.'
  if (loaded.id === engine.refusedLoad?.model.id) {
    return engine.contextSize
      ? `Nothing changed — still running at ${engine.contextSize.toLocaleString()} tokens.`
      : 'Nothing changed — it is still loaded and ready to chat.'
  }
  return `Nothing changed — ${loaded.name} is still loaded and ready to chat.`
}

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

  return (
    <div className={styles.refusalCallout}>
      <span className={styles.refusalIcon}>
        <Icon name="alert" size={16} />
      </span>
      <div className={styles.recText}>
        <strong>Didn&rsquo;t load {refused.model.name}</strong>
        <span>{refused.reason}</span>
        <span className={styles.refusalFootnote}>{describeWhatSurvived(engine)}</span>
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
