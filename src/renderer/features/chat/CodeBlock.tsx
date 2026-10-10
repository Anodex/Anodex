import { useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { highlightCode } from '../../lib/highlight'
import styles from './CodeBlock.module.css'

/** How much of an untagged block its language is guessed from while it is shut. */
const LANGUAGE_GUESS_CHARS = 2000

/** A finished block this short opens by itself; a longer one stays a one-line summary. */
const SHORT_BLOCK_LINES = 15

interface CodeBlockProps {
  code: string
  language?: string
  /**
   * The block is complete (its reply has finished). Only then may a short block
   * open by itself: open while streaming, it would be highlighted on every frame.
   */
  settled?: boolean
}

/** A fenced code block with a language label, copy button, and syntax highlighting. */
export function CodeBlock({ code, language, settled = false }: CodeBlockProps): JSX.Element {
  // What the person chose, if they have; until then a settled short block opens
  // by itself. The four-line board in a reply needed a click just to be seen.
  const [toggled, setToggled] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const lineCount = useMemo(() => countLines(code), [code])
  const expanded = toggled ?? (settled && lineCount <= SHORT_BLOCK_LINES)
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
          onClick={() => setToggled(!expanded)}
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
