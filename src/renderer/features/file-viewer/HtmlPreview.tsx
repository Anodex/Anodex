import styles from './HtmlPreview.module.css'

interface HtmlPreviewProps {
  content: string
  fileName: string
}

/**
 * Read-only rendered preview of an HTML file. `sandbox="allow-same-origin"`
 * with no `allow-scripts` renders the markup/CSS but strips out `<script>`
 * tags and inline event handlers — this file may be AI-written, so it's
 * treated as inert content, not trusted code. Editing happens via the
 * Code toggle in `FileViewerPanel`, which opens the same content in `CodeEditor`.
 */
export function HtmlPreview({ content, fileName }: HtmlPreviewProps): JSX.Element {
  return (
    <iframe
      className={styles.frame}
      srcDoc={content}
      sandbox="allow-same-origin"
      title={fileName}
    />
  )
}
