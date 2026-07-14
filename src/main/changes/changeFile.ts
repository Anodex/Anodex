import type { ChangeStatus, ChangeTask } from '@shared/change.types'

export interface ParsedChange {
  title: string
  status: ChangeStatus
  why: string
  tasks: ChangeTask[]
  createdAt: string
  updatedAt: string
}

const FRONTMATTER_DELIMITER = '---'
const VALID_STATUSES: ChangeStatus[] = ['proposed', 'in_progress', 'done', 'archived']
/** The only headings `parseSection` treats as section boundaries — see its doc comment. */
const KNOWN_SECTION_HEADERS = ['## Why', '## Tasks']

/**
 * Parses a change proposal markdown file: a `---`-delimited frontmatter block
 * of flat `key: value` pairs, followed by a `## Why` section and a `## Tasks`
 * section of standard markdown checkboxes. Hand-rolled, mirroring
 * `skillFile.ts`'s own reasoning — the schema is deliberately flat and small,
 * so a real YAML/markdown parser would be more machinery than the format
 * needs, and using plain checkbox syntax keeps the file readable in any
 * editor, not just Anodex.
 */
export function parseChangeFile(raw: string, filePath: string): ParsedChange {
  const { frontmatter, body } = splitFrontmatter(raw, filePath)
  const fields = parseFrontmatterFields(frontmatter, filePath)

  const title = requireField(fields, 'title', filePath)
  const statusRaw = requireField(fields, 'status', filePath)
  if (!VALID_STATUSES.includes(statusRaw as ChangeStatus)) {
    throw new Error(
      `Change file "${filePath}" has an invalid status "${statusRaw}" (expected one of ${VALID_STATUSES.join(', ')}).`
    )
  }
  const createdAt = requireField(fields, 'createdAt', filePath)
  const updatedAt = requireField(fields, 'updatedAt', filePath)

  return {
    title,
    status: statusRaw as ChangeStatus,
    why: parseSection(body, 'Why'),
    tasks: parseTasks(body),
    createdAt,
    updatedAt
  }
}

/** Serializes a change back to the same markdown shape `parseChangeFile` reads. */
export function serializeChangeFile(change: ParsedChange): string {
  const taskLines = change.tasks
    .map((task) => `- [${task.done ? 'x' : ' '}] ${sanitizeSingleLine(task.title)}`)
    .join('\n')
  return `---
title: ${sanitizeSingleLine(change.title)}
status: ${change.status}
createdAt: ${change.createdAt}
updatedAt: ${change.updatedAt}
---

## Why

${change.why.trim()}

## Tasks

${taskLines}
`
}

/**
 * Collapse a value that must round-trip through a single physical line — a
 * frontmatter field or a `- [ ] <title>` checkbox — to one line. Without
 * this, model- or user-supplied text containing a raw newline (e.g. a title
 * pasted from a multi-line goal) breaks the format it's embedded in: an
 * embedded frontmatter continuation line either fails `parseFrontmatterFields`
 * outright (no ":" on that line) or, worse, is silently read back as a bogus
 * extra field; an embedded checkbox continuation line just fails the task
 * regex and vanishes, shifting every later task's 1-based position.
 */
function sanitizeSingleLine(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitFrontmatter(raw: string, filePath: string): { frontmatter: string; body: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`Change file "${filePath}" must start with a "---" frontmatter block.`)
  }
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === FRONTMATTER_DELIMITER)
  if (closingIndex === -1) {
    throw new Error(`Change file "${filePath}" has an unterminated frontmatter block.`)
  }
  const frontmatter = lines.slice(1, closingIndex + 1).join('\n')
  const body = lines.slice(closingIndex + 2).join('\n')
  return { frontmatter, body }
}

function parseFrontmatterFields(frontmatter: string, filePath: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    if (!line.trim()) continue
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) {
      throw new Error(`Change file "${filePath}" has an invalid frontmatter line: "${line}"`)
    }
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    fields[key] = value
  }
  return fields
}

function requireField(fields: Record<string, string>, key: string, filePath: string): string {
  const value = fields[key]
  if (!value) throw new Error(`Change file "${filePath}" is missing required field "${key}".`)
  return value
}

/**
 * Extract a `## <name>` section's body text, up to the next *known* section
 * heading (`## Why` / `## Tasks`) or end of file. Deliberately checks against
 * `KNOWN_SECTION_HEADERS` rather than "any line starting with `## `" — the
 * `why` field is freeform prose the model writes, and it can legitimately
 * contain its own `## Something` heading-shaped line (e.g. explaining a
 * migration plan); treating that as a section boundary silently truncated
 * the real content at that line.
 */
function parseSection(body: string, name: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const startIndex = lines.findIndex((line) => line.trim() === `## ${name}`)
  if (startIndex === -1) return ''
  const rest = lines.slice(startIndex + 1)
  const endIndex = rest.findIndex((line) => KNOWN_SECTION_HEADERS.includes(line.trim()))
  const section = endIndex === -1 ? rest : rest.slice(0, endIndex)
  return section.join('\n').trim()
}

/** Parse `- [ ] Title` / `- [x] Title` checkbox lines out of the `## Tasks` section. */
function parseTasks(body: string): ChangeTask[] {
  const section = parseSection(body, 'Tasks')
  if (!section) return []
  const tasks: ChangeTask[] = []
  for (const line of section.split('\n')) {
    const match = line.trim().match(/^-\s*\[([ xX])\]\s+(.+)$/)
    if (!match) continue
    tasks.push({ title: match[2].trim(), done: match[1].toLowerCase() === 'x' })
  }
  return tasks
}
