import { useModelStore } from '../stores/modelStore'
import type { EngineState } from '@shared/model.types'
import styles from './ModelStatusBadge.module.css'

type Tone = 'idle' | 'busy' | 'ready' | 'error'

interface Display {
  tone: Tone
  label: string
  pulse: boolean
}

function describe(engine: EngineState): Display {
  if (engine.status === 'error') return { tone: 'error', label: 'Model error', pulse: false }
  if (engine.status === 'loading') {
    return { tone: 'busy', label: `Loading ${engine.model?.name ?? 'model'}…`, pulse: true }
  }
  if (engine.status === 'ready') {
    if (engine.generating) return { tone: 'busy', label: 'Generating…', pulse: true }
    return { tone: 'ready', label: engine.model?.name ?? 'Model ready', pulse: false }
  }
  return { tone: 'idle', label: 'No model loaded', pulse: false }
}

/** Compact live indicator of the local engine's state (used in the top bar). */
export function ModelStatusBadge(): JSX.Element {
  const engine = useModelStore((s) => s.engine)
  const { tone, label, pulse } = describe(engine)

  return (
    <div className={styles.badge} title={label}>
      <span className={`${styles.dot} ${styles[tone]} ${pulse ? styles.pulse : ''}`} />
      <span className={styles.label}>{label}</span>
    </div>
  )
}
