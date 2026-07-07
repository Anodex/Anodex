import styles from './PlaceholderPanel.module.css'

export function SchedulerPanel(): JSX.Element {
  return (
    <div className={styles.panel}>
      <div className={styles.placeholder}>
        <p className={styles.title}>Schedule automated research tasks</p>
        <p className={styles.subtitle}>Coming soon</p>
      </div>
    </div>
  )
}
