export type ReleaseNoteBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'code'; text: string }

/** Parse the small Markdown subset used by GitHub release notes. */
export function parseReleaseNotes(body: string): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = []
  let paragraph: string[] = []
  let items: string[] = []
  let code: string[] | null = null

  const flush = (): void => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    if (items.length) blocks.push({ kind: 'list', items })
    paragraph = []
    items = []
  }

  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('```')) {
      if (code) {
        blocks.push({ kind: 'code', text: code.join('\n') })
        code = null
      } else {
        flush()
        code = []
      }
      continue
    }
    if (code) {
      code.push(rawLine)
      continue
    }
    if (!line) {
      flush()
      continue
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      if (paragraph.length) flush()
      items.push(bullet[1])
      continue
    }
    if (items.length) items[items.length - 1] += ` ${line}`
    else paragraph.push(line)
  }
  flush()
  if (code) blocks.push({ kind: 'code', text: code.join('\n') })
  return blocks
}
