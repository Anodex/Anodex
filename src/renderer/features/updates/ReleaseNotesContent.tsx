import type { ReactNode } from 'react'
import styles from './ReleaseNotesContent.module.css'
import { parseReleaseNotes } from './releaseNotesParser'

function safeLink(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={index}>{part.slice(1, -1)}</em>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const href = safeLink(link[2])
      return href ? (
        <a key={index} href={href} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      ) : (
        link[1]
      )
    }
    return part
  })
}

export function ReleaseNotesContent({ body }: { body: string }): JSX.Element {
  return (
    <div className={styles.notes}>
      {parseReleaseNotes(body).map((block, index) => {
        if (block.kind === 'heading') {
          return block.level <= 2 ? (
            <h3 key={index}>{inline(block.text)}</h3>
          ) : (
            <h4 key={index}>{inline(block.text)}</h4>
          )
        }
        if (block.kind === 'list') {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </ul>
          )
        }
        if (block.kind === 'code') return <pre key={index}>{block.text}</pre>
        return <p key={index}>{inline(block.text)}</p>
      })}
    </div>
  )
}
