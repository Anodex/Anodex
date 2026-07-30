import { Fragment, useMemo, type ReactNode } from 'react'
import type { WebSource } from '@shared/webSources.types'
import { citedSourceMap, type CitedSource } from './citedSources'
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

/** Render `inline code`, **bold**, and `[S1]` source citations within a single line. */
function renderInline(
  text: string,
  keyBase: string,
  sources?: Map<string, CitedSource>
): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[S[1-9]\d*\])/g).map((part, index) => {
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
    if (/^\[S[1-9]\d*\]$/.test(part)) {
      const cited = sources?.get(part.slice(1, -1))
      // An unresolved marker is left as literal text on purpose. The model
      // inventing [S7] when only three sources exist is exactly the kind of
      // fabrication worth leaving visible rather than dressing up as a link.
      if (!cited) return <Fragment key={key}>{part}</Fragment>
      return <CitationChip key={key} source={cited} />
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

function CitationChip({ source: cited }: { source: CitedSource }): JSX.Element {
  const { source, number } = cited
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      className={`${styles.citation} ${source.verified ? '' : styles.citationLead}`}
      title={
        source.verified
          ? `${source.title} — ${hostOf(source.url)}`
          : `${source.title} — ${hostOf(source.url)} (search result, page not fetched)`
      }
    >
      {number}
    </a>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Render a text segment as paragraphs, preserving single line breaks. */
function renderTextSegment(
  text: string,
  keyBase: string,
  sources?: Map<string, CitedSource>
): ReactNode {
  return text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim().length > 0)
    .map((paragraph, pIndex) => (
      <p key={`${keyBase}-p${pIndex}`} className={styles.paragraph}>
        {paragraph.split('\n').map((line, lIndex) => (
          <Fragment key={lIndex}>
            {lIndex > 0 && <br />}
            {renderInline(line, `${keyBase}-p${pIndex}-l${lIndex}`, sources)}
          </Fragment>
        ))}
      </p>
    ))
}

export function MessageContent({
  content,
  sources
}: {
  content: string
  sources?: WebSource[]
}): JSX.Element {
  const segments = parseSegments(content)
  const sourceMap = useMemo(() => citedSourceMap(sources), [sources])
  return (
    <div className={styles.content}>
      {segments.map((segment, index) =>
        segment.type === 'code' ? (
          <CodeBlock key={index} code={segment.content} language={segment.language} />
        ) : (
          <Fragment key={index}>
            {renderTextSegment(segment.content, `s${index}`, sourceMap)}
          </Fragment>
        )
      )}
    </div>
  )
}
