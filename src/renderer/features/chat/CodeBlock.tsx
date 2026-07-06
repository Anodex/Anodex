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
  const [copied, setCopied] = useState(false)
  const highlighted = useMemo(() => highlightCode(code, language), [code, language])

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
        <span className={styles.language}>{language || highlighted.language || 'code'}</span>
        <button className={styles.copy} onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={styles.pre}>
        {/* highlightCode always HTML-escapes the source before wrapping it in
            token spans, so this markup is safe even though code is model-generated. */}
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
      </pre>
    </div>
  )
}
