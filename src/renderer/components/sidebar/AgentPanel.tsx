import styles from './PlaceholderPanel.module.css'

export function AgentPanel(): JSX.Element {
  return (
    <div className={styles.panel}>
      <div className={styles.placeholder}>
        <p className={styles.title}>Give the agent a goal and let it work autonomously</p>
        <p className={styles.subtitle}>Coming soon</p>
      </div>
    </div>
  )
}
