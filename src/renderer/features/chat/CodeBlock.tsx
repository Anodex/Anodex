import { useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { highlightCode } from '../../lib/highlight'
import styles from './CodeBlock.module.css'

/** How much of an untagged block its language is guessed from while it is shut. */
const LANGUAGE_GUESS_CHARS = 2000

interface CodeBlockProps {
  code: string
  language?: string
}

/** A fenced code block with a language label, copy button, and syntax highlighting. */
export function CodeBlock({ code, language }: CodeBlockProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  // Colouring is only drawn open, and a block streams in shut: highlighting every
  // frame of a block nobody can see cost the window a steady share of a core, and
  // the whole block again each time. Shut, only the label needs a language, and a
  // block with no fence tag has it guessed from its opening, which stops changing
  // once that much has arrived.
  const highlighted = useMemo(
    () => (expanded ? highlightCode(code, language) : null),
    [expanded, code, language]
  )
  const guessSample = language || expanded ? '' : code.slice(0, LANGUAGE_GUESS_CHARS)
  const guessedLanguage = useMemo(
    () => (guessSample ? highlightCode(guessSample).language : null),
    [guessSample]
  )
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
          <span className={styles.language}>
            {language || highlighted?.language || guessedLanguage || 'code'}
          </span>
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
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted?.html ?? '' }} />
        </pre>
      )}
    </div>
  )
}

function countLines(code: string): number {
  if (code.length === 0) return 0
  return code.split('\n').length
}
