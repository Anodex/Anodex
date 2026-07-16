import { Fragment, type ReactNode } from 'react'
import { CriticalThinkingChart } from './CriticalThinkingChart'
import { parseCriticalThinkingChart } from './criticalThinkingCharts'
import styles from './CriticalThinkingReport.module.css'

function renderInline(text: string, keyBase: string): ReactNode[] {
  return text
    .split(/(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter(Boolean)
    .map((part, index) => {
      const key = `${keyBase}-${index}`
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part)
      if (link) {
        return (
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        )
      }
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={key}>{part.slice(2, -2)}</strong>
      if (/^`[^`]+`$/.test(part)) return <code key={key}>{part.slice(1, -1)}</code>
      return <Fragment key={key}>{part}</Fragment>
    })
}

function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index]
  if (!line?.trim()) return true
  return (
    /^#{1,4}\s+/.test(line) ||
    /^```/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    /^>\s?/.test(line) ||
    (/\|/.test(line) && isTableSeparator(lines[index + 1] ?? ''))
  )
}

/** Safe, dependency-free Markdown renderer tailored to long cited research reports. */
export function CriticalThinkingReport({ report }: { report: string }): JSX.Element {
  const lines = report.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      continue
    }

    const fence = /^```([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      const code: string[] = []
      index++
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++])
      if (index < lines.length) index++
      const chart =
        fence[1].toLowerCase() === 'chart' ? parseCriticalThinkingChart(code.join('\n')) : null
      if (chart) {
        blocks.push(<CriticalThinkingChart key={key++} spec={chart} />)
        continue
      }
      blocks.push(
        <pre key={key++} className={styles.codeBlock} data-language={fence[1] || undefined}>
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const content = renderInline(heading[2], `h${key}`)
      if (level === 1) blocks.push(<h1 key={key++}>{content}</h1>)
      else if (level === 2) blocks.push(<h2 key={key++}>{content}</h2>)
      else if (level === 3) blocks.push(<h3 key={key++}>{content}</h3>)
      else blocks.push(<h4 key={key++}>{content}</h4>)
      index++
      continue
    }

    if (/\|/.test(line) && isTableSeparator(lines[index + 1] ?? '')) {
      const header = tableCells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].trim() && /\|/.test(lines[index])) {
        rows.push(tableCells(lines[index++]))
      }
      blocks.push(
        <div key={key++} className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInline(cell, `th${key}-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {header.map((_, cellIndex) => (
                    <td key={cellIndex}>
                      {renderInline(row[cellIndex] ?? '', `td${key}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    const unordered = /^[-*]\s+/.test(line)
    const ordered = /^\d+\.\s+/.test(line)
    if (unordered || ordered) {
      const items: string[] = []
      const pattern = unordered ? /^[-*]\s+(.+)$/ : /^\d+\.\s+(.+)$/
      while (index < lines.length) {
        const match = pattern.exec(lines[index])
        if (!match) break
        items.push(match[1])
        index++
      }
      const children = items.map((item, itemIndex) => (
        <li key={itemIndex}>{renderInline(item, `li${key}-${itemIndex}`)}</li>
      ))
      blocks.push(ordered ? <ol key={key++}>{children}</ol> : <ul key={key++}>{children}</ul>)
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index++].replace(/^>\s?/, ''))
      }
      blocks.push(<blockquote key={key++}>{renderInline(quote.join(' '), `q${key}`)}</blockquote>)
      continue
    }

    const paragraph: string[] = [line]
    index++
    while (index < lines.length && !startsBlock(lines, index)) paragraph.push(lines[index++])
    blocks.push(<p key={key++}>{renderInline(paragraph.join(' '), `p${key}`)}</p>)
  }

  return (
    <article className={styles.report} data-critical-thinking-report>
      {blocks}
    </article>
  )
}
