import type { ModelUsageBreakdown } from '@shared/stats.types'
import { colorForModel } from './modelColor'
import styles from './ModelBreakdownList.module.css'

interface ModelBreakdownListProps {
  models: ModelUsageBreakdown[]
}

/** Per-model lifetime input/output token split, sorted by usage descending. */
export function ModelBreakdownList({ models }: ModelBreakdownListProps): JSX.Element {
  if (models.length === 0) {
    return <p className={styles.emptyHint}>No model activity yet.</p>
  }

  return (
    <ul className={styles.list}>
      {models.map((model) => (
        <li key={model.modelId} className={styles.row}>
          <span className={styles.colorDot} style={{ background: colorForModel(model.modelId) }} />
          <span className={styles.name}>{model.modelName}</span>
          <span className={styles.tokens}>
            {model.inputTokens.toLocaleString()} in · {model.outputTokens.toLocaleString()} out
          </span>
          <span className={styles.share}>{Math.round(model.share * 100)}%</span>
        </li>
      ))}
    </ul>
  )
}
