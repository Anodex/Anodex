import { buildSideBySideDiffRows, buildUnifiedDiffLines } from '../../lib/diffRows'
import styles from './DiffView.module.css'

/** Renders a file-change diff, in whichever layout the user prefers (Appearance settings). */
export function DiffView({
  before,
  after,
  mode
}: {
  before: string
  after: string
  mode: 'unified' | 'sideBySide'
}): JSX.Element {
  if (mode === 'sideBySide') {
    const rows = buildSideBySideDiffRows(before, after)
    return (
      <div className={styles.sideBySide}>
        <div className={styles.column}>
          {rows.map((row, index) => (
            <div key={index} className={`${styles.line} ${styles[row.left.type]}`}>
              <span className={styles.lineText}>{row.left.text}</span>
            </div>
          ))}
        </div>
        <div className={styles.column}>
          {rows.map((row, index) => (
            <div key={index} className={`${styles.line} ${styles[row.right.type]}`}>
              <span className={styles.lineText}>{row.right.text}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const lines = buildUnifiedDiffLines(before, after)
  return (
    <div className={styles.unified}>
      {lines.map((line, index) => (
        <div key={index} className={`${styles.line} ${styles[line.type]}`}>
          <span className={styles.marker}>
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ''}
          </span>
          <span className={styles.lineText}>{line.text}</span>
        </div>
      ))}
    </div>
  )
}
