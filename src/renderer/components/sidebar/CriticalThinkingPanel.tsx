import styles from './PlaceholderPanel.module.css'

export function CriticalThinkingPanel(): JSX.Element {
  return (
    <div className={styles.panel}>
      <div className={styles.placeholder}>
        <p className={styles.title}>Deep research with web search & AI synthesis</p>
        <p className={styles.subtitle}>Coming soon</p>
      </div>
    </div>
  )
}
