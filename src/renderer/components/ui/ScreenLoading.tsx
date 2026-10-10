import { Spinner } from './Spinner'
import styles from './ScreenLoading.module.css'

/**
 * Shown for the moment a screen's code is read the first time it is opened.
 * Screens most launches never visit are not part of the startup bundle; they
 * load from disk in milliseconds, so this is rarely seen at all.
 */
export function ScreenLoading(): JSX.Element {
  return (
    <div className={styles.loading} role="status" aria-label="Loading">
      <Spinner size={16} />
    </div>
  )
}
