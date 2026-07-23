import { StatusDot, type StatusTone } from '../ui/StatusDot'
import type { CometPhase } from './useCometPhase'
import styles from './ModelStatusDot.module.css'

/**
 * The sidebar footer's model-status dot. While a local model loads, a
 * cyan/blue/violet comet orbits the dot instead of the plain pulsing halo —
 * the one moment that earns the "arrival" accent (see midnight.css) — and
 * speeds up if the load runs long. The instant it resolves, the comet
 * flares into the dot rather than the color just cutting over. Every other
 * tone renders the plain StatusDot. `phase` comes from `useCometPhase`,
 * owned by the parent so it survives ModelStatusMenu swapping which branch
 * (and which dot element) is mounted around it.
 */
export function ModelStatusDot({
  tone,
  phase
}: {
  tone: StatusTone
  phase: CometPhase
}): JSX.Element {
  if (tone !== 'running' && phase !== 'arriving') {
    return <StatusDot tone={tone} />
  }

  return (
    <span className={styles.cometDot} data-phase={phase} aria-hidden="true">
      <span className={styles.cometRing} />
    </span>
  )
}
