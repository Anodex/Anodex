import type { ToolCallPreview } from '@shared/tools.types'
import styles from './ChatHtmlPreview.module.css'

type HtmlPreview = Extract<ToolCallPreview, { kind: 'html' }>

/**
 * Sandboxed chat preview for AI-created or workspace HTML.
 *
 * Scripts are allowed so small games/animations can run, but same-origin is not:
 * the frame gets an opaque origin and cannot reach Anodex's renderer state.
 */
export function ChatHtmlPreview({ preview }: { preview: HtmlPreview }): JSX.Element {
  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <span className={styles.title}>{preview.title}</span>
        <span className={styles.path}>{preview.path}</span>
      </div>
      <iframe
        className={styles.frame}
        srcDoc={preview.content}
        sandbox="allow-scripts"
        title={preview.title}
      />
    </div>
  )
}
