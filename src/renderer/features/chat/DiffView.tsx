import { useMemo } from 'react'
import { buildSideBySideDiffRows, buildUnifiedDiffLines } from '../../lib/diffRows'
import { highlightCode, languageForFileName } from '../../lib/highlight'
import styles from './DiffView.module.css'

function highlight(text: string, language: string | undefined): string {
  if (!text) return ''
  return highlightCode(text, language).html
}

/** Renders a file-change diff, in whichever layout the user prefers (Appearance settings). */
export function DiffView({
  before,
  after,
  mode,
  path
}: {
  before: string
  after: string
  mode: 'unified' | 'sideBySide'
  /** File path/name, used to pick a syntax-highlighting language. */
  path?: string
}): JSX.Element {
  const language = useMemo(() => (path ? languageForFileName(path) : undefined), [path])
  const rows = useMemo(() => buildSideBySideDiffRows(before, after), [before, after])
  const lines = useMemo(() => buildUnifiedDiffLines(before, after), [before, after])

  if (mode === 'sideBySide') {
    return (
      <div className={styles.sideBySide}>
        <div className={styles.column}>
          {rows.map((row, index) =>
            row.left.type === 'gap' ? (
              <div key={index} className={styles.gap}>
                <span className={styles.gapText}>⋯ {row.count} unchanged lines</span>
              </div>
            ) : (
              <div key={index} className={`${styles.line} ${styles[row.left.type]}`}>
                <span className={styles.lineNumber}>{row.left.line ?? ''}</span>
                <span
                  className={styles.lineText}
                  dangerouslySetInnerHTML={{ __html: highlight(row.left.text, language) }}
                />
              </div>
            )
          )}
        </div>
        <div className={styles.column}>
          {rows.map((row, index) =>
            row.right.type === 'gap' ? (
              <div key={index} className={styles.gap} />
            ) : (
              <div key={index} className={`${styles.line} ${styles[row.right.type]}`}>
                <span className={styles.lineNumber}>{row.right.line ?? ''}</span>
                <span
                  className={styles.lineText}
                  dangerouslySetInnerHTML={{ __html: highlight(row.right.text, language) }}
                />
              </div>
            )
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.unified}>
      {lines.map((line, index) =>
        line.type === 'gap' ? (
          <div key={index} className={styles.gap}>
            <span className={styles.gapText}>⋯ {line.count} unchanged lines</span>
          </div>
        ) : (
          <div key={index} className={`${styles.line} ${styles[line.type]}`}>
            <span className={styles.lineNumber}>{line.oldLine ?? ''}</span>
            <span className={styles.lineNumber}>{line.newLine ?? ''}</span>
            <span className={styles.marker}>
              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ''}
            </span>
            <span
              className={styles.lineText}
              dangerouslySetInnerHTML={{ __html: highlight(line.text, language) }}
            />
          </div>
        )
      )}
    </div>
  )
}
