import { useEffect, useState } from 'react'
import { anodex } from '../../lib/anodex'
import styles from './HtmlPreview.module.css'

interface HtmlPreviewProps {
  /** The live editor buffer for the HTML file — not necessarily what's on disk. */
  content: string
  /** Workspace-relative path, used to resolve the page's relative asset references. */
  path: string
  fileName: string
}

/**
 * Read-only rendered preview of an HTML file.
 *
 * The frame is fed a *self-contained* document: an `srcDoc` iframe has no base
 * URL, so a page's own `<link rel="stylesheet" href="style.css">` and
 * `<script src="app.js">` would silently resolve to nothing and the page would
 * render as unstyled markup. Main inlines those local siblings first (see
 * `prepareHtmlPreviewSource`), against the current buffer rather than the file
 * on disk so unsaved edits preview accurately.
 *
 * `sandbox="allow-same-origin"` with no `allow-scripts` renders the markup and
 * CSS but strips out `<script>` tags and inline event handlers — this file may
 * be AI-written, so it's treated as inert content, not trusted code. The
 * pop-out window (`openHtmlPreviewWindow`) is where scripts actually run, at an
 * opaque origin with no access to the app. Editing happens via the Code toggle
 * in `FileViewerPanel`, which opens the same content in `CodeEditor`.
 */
export function HtmlPreview({ content, path, fileName }: HtmlPreviewProps): JSX.Element {
  // Starts as the raw source so the first paint isn't a blank frame; swapped
  // for the asset-inlined version as soon as main returns it. Falls back to
  // the raw source if inlining fails, which still renders — just unstyled,
  // exactly the old behaviour, rather than showing nothing at all.
  const [resolved, setResolved] = useState(content)

  useEffect(() => {
    let cancelled = false
    void anodex.workspace.prepareHtmlPreview(path, content).then((res) => {
      if (cancelled) return
      setResolved(res.ok ? res.value : content)
    })
    return () => {
      cancelled = true
    }
  }, [path, content])

  return (
    <iframe
      className={styles.frame}
      srcDoc={resolved}
      sandbox="allow-same-origin"
      title={fileName}
    />
  )
}
