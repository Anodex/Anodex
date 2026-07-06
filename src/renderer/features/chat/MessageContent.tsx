import { Fragment, type ReactNode } from 'react'
import { CodeBlock } from './CodeBlock'
import styles from './MessageContent.module.css'

/**
 * Lightweight markdown rendering tuned for a coding assistant. Deliberately
 * dependency-free: it handles fenced code blocks, inline code, and bold — the
 * cases that matter most for readable answers — and safely renders everything
 * as React nodes (never `dangerouslySetInnerHTML`). Swap for a full markdown
 * library here if richer formatting is needed later.
 */

interface Segment {
  type: 'text' | 'code'
  content: string
  language?: string
}

/** Split text into interleaved text/code segments, tolerant of an unclosed
 *  trailing fence so streaming code renders as a code block while in progress. */
function parseSegments(text: string): Segment[] {
  const segments: Segment[] = []
  const fence = /```([\w+#.-]*)\n?([\s\S]*?)```/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: 'text', content: text.slice(cursor, match.index) })
    }
    segments.push({
      type: 'code',
      language: match[1] || undefined,
      content: match[2].replace(/\n$/, '')
    })
    cursor = fence.lastIndex
  }

  const rest = text.slice(cursor)
  const openFence = rest.indexOf('```')
  if (openFence !== -1) {
    if (openFence > 0) segments.push({ type: 'text', content: rest.slice(0, openFence) })
    const after = rest.slice(openFence + 3)
    const newline = after.indexOf('\n')
    const language = (newline === -1 ? after : after.slice(0, newline)).trim()
    const content = newline === -1 ? '' : after.slice(newline + 1)
    segments.push({ type: 'code', language: language || undefined, content })
  } else if (rest) {
    segments.push({ type: 'text', content: rest })
  }

  return segments
}

/** Render `inline code` and **bold** spans within a single line. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    const key = `${keyBase}-${index}`
    if (/^`[^`]+`$/.test(part)) {
      return (
        <code key={key} className={styles.inlineCode}>
          {part.slice(1, -1)}
        </code>
      )
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

/** Render a text segment as paragraphs, preserving single line breaks. */
function renderTextSegment(text: string, keyBase: string): ReactNode {
  return text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim().length > 0)
    .map((paragraph, pIndex) => (
      <p key={`${keyBase}-p${pIndex}`} className={styles.paragraph}>
        {paragraph.split('\n').map((line, lIndex) => (
          <Fragment key={lIndex}>
            {lIndex > 0 && <br />}
            {renderInline(line, `${keyBase}-p${pIndex}-l${lIndex}`)}
          </Fragment>
        ))}
      </p>
    ))
}

export function MessageContent({ content }: { content: string }): JSX.Element {
  const segments = parseSegments(content)
  return (
    <div className={styles.content}>
      {segments.map((segment, index) =>
        segment.type === 'code' ? (
          <CodeBlock key={index} code={segment.content} language={segment.language} />
        ) : (
          <Fragment key={index}>{renderTextSegment(segment.content, `s${index}`)}</Fragment>
        )
      )}
    </div>
  )
}
