import { useMemo, useRef } from 'react'
import { highlightCode } from '../../lib/highlight'
import styles from './CodeEditor.module.css'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  language?: string
}

/**
 * A minimal code editor: a transparent `<textarea>` stacked exactly on top of
 * a highlighted `<pre>`, rather than a third-party editor dependency. The
 * textarea supplies real editing behavior (cursor, selection, undo,
 * copy/paste, IME) for free; the `<pre>` underneath repaints via
 * `highlightCode` (the same helper `CodeBlock` uses for chat code fences) on
 * every keystroke. Scroll position is mirrored from the textarea onto the
 * `<pre>` and the line-number gutter, since only the textarea is interactive.
 */
export function CodeEditor({ value, onChange, language }: CodeEditorProps): JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const highlighted = useMemo(() => highlightCode(value, language), [value, language])
  const lineCount = useMemo(() => value.split('\n').length, [value])

  const handleScroll = (event: React.UIEvent<HTMLTextAreaElement>): void => {
    const { scrollTop, scrollLeft } = event.currentTarget
    if (preRef.current) {
      preRef.current.scrollTop = scrollTop
      preRef.current.scrollLeft = scrollLeft
    }
    if (gutterRef.current) gutterRef.current.scrollTop = scrollTop
  }

  // Tab inserts two spaces instead of moving focus. Mutates the textarea's DOM
  // value directly so the cursor can be repositioned synchronously — React
  // will bail on the DOM write in its next render since `onChange` sets the
  // same string into state.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const el = event.currentTarget
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = `${value.slice(0, start)}  ${value.slice(end)}`
    el.value = next
    el.selectionStart = el.selectionEnd = start + 2
    onChange(next)
  }

  return (
    <div className={styles.wrap}>
      <div ref={gutterRef} className={styles.gutter}>
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className={styles.lineNumber}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className={styles.codeArea}>
        <pre ref={preRef} className={styles.highlightLayer} aria-hidden="true">
          <code
            className="hljs"
            // highlightCode always HTML-escapes the source before wrapping it in
            // token spans (see highlight.ts), so this is safe even though the
            // content is a user-editable file.
            dangerouslySetInnerHTML={{ __html: `${highlighted.html}\n` }}
          />
        </pre>
        <textarea
          data-computer-control-target="file-viewer-editor"
          className={styles.textarea}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
        />
      </div>
    </div>
  )
}
