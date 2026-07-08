import { useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { highlightCode } from '../../lib/highlight'
import styles from './CodeBlock.module.css'

interface CodeBlockProps {
  code: string
  language?: string
}

/** A fenced code block with a language label, copy button, and syntax highlighting. */
export function CodeBlock({ code, language }: CodeBlockProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const highlighted = useMemo(() => highlightCode(code, language), [code, language])
  const lineCount = useMemo(() => countLines(code), [code])
  const summary = `${lineCount} ${lineCount === 1 ? 'line' : 'lines'} - ${code.length} chars`

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* Clipboard unavailable — silently ignore. */
    }
  }

  return (
    <div className={styles.block}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />
          <span className={styles.language}>{language || highlighted.language || 'code'}</span>
          <span className={styles.summary}>{summary}</span>
        </button>
        <button type="button" className={styles.copy} onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {expanded && (
        <pre className={styles.pre}>
          {/* highlightCode always HTML-escapes the source before wrapping it in
              token spans, so this markup is safe even though code is model-generated. */}
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
        </pre>
      )}
    </div>
  )
}

function countLines(code: string): number {
  if (code.length === 0) return 0
  return code.split('\n').length
}
