import { StatusDot, type StatusTone } from './StatusDot'
import type { CometPhase } from './useCometPhase'
import styles from './CometStatusDot.module.css'

/**
 * The comet-trail dot for status indicators that earn the rare cyan/blue/
 * violet "arrival" accent (see midnight.css) instead of the plain pulsing
 * halo — a per-session event worth marking specially, not something that
 * fires on every message. Today: local model loading, MCP server
 * connecting. While `tone` is `'running'`, a comet orbits the dot, speeding
 * up and brightening if it runs long; the instant it resolves, the comet
 * flares into the dot rather than the color just cutting over. Every other
 * tone renders the plain `StatusDot`. `phase` comes from `useCometPhase`,
 * owned by the parent — needed whenever the caller might swap which JSX
 * branch (and dot element) is mounted right as the status resolves, since a
 * freshly mounted dot would otherwise miss the transition and skip the
 * flare.
 */
export function CometStatusDot({
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
