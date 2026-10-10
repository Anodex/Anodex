import { Icon, type IconName } from './Icon'
import styles from './ExampleCards.module.css'

export interface ExampleCard {
  icon: IconName
  title: string
  description: string
  onSelect: () => void
}

/**
 * "Get started with an example": a heading over cards that each open an editor
 * already filled in. Shared so every page that offers starting points (the
 * Scheduler's tasks, the Agent's goals) looks and behaves the same.
 */
export function ExampleCards({
  title,
  examples
}: {
  title: string
  examples: ExampleCard[]
}): JSX.Element {
  return (
    <div className={styles.examples}>
      <h2 className={styles.examplesTitle}>{title}</h2>
      <div className={styles.exampleGrid}>
        {examples.map((example) => (
          <button
            key={example.title}
            type="button"
            className={styles.exampleCard}
            onClick={example.onSelect}
          >
            <div className={styles.exampleIcon}>
              <Icon name={example.icon} size={16} />
            </div>
            <div>
              <p className={styles.exampleTitle}>{example.title}</p>
              <p className={styles.exampleDescription}>{example.description}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
