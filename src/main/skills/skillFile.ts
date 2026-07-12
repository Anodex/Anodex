import type { Skill } from '@shared/skill.types'

export type ParsedSkill = Omit<Skill, 'scope'>

const FRONTMATTER_DELIMITER = '---'

/**
 * Parses a skill markdown file: a `---`-delimited frontmatter block of flat
 * `key: value` pairs (plus one inline `[a, b, c]` array form for `keywords`/
 * `tools`), followed by a markdown body. Hand-rolled rather than pulling in a
 * YAML library — the schema is deliberately flat, so a real parser would be
 * more machinery than the format needs.
 */
export function parseSkillFile(raw: string, filePath: string): ParsedSkill {
  const { frontmatter, body } = splitFrontmatter(raw, filePath)
  const fields = parseFrontmatterFields(frontmatter, filePath)

  const name = requireField(fields, 'name', filePath)
  const description = requireField(fields, 'description', filePath)

  return {
    name,
    description,
    keywords: toStringArray(fields.keywords),
    tools: toStringArray(fields.tools),
    body: body.trim(),
    filePath
  }
}

function splitFrontmatter(raw: string, filePath: string): { frontmatter: string; body: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`Skill file "${filePath}" must start with a "---" frontmatter block.`)
  }
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === FRONTMATTER_DELIMITER)
  if (closingIndex === -1) {
    throw new Error(`Skill file "${filePath}" has an unterminated frontmatter block.`)
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
      throw new Error(`Skill file "${filePath}" has an invalid frontmatter line: "${line}"`)
    }
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    fields[key] = value
  }
  return fields
}

function requireField(fields: Record<string, string>, key: string, filePath: string): string {
  const value = fields[key]
  if (!value) throw new Error(`Skill file "${filePath}" is missing required field "${key}".`)
  return value
}

/** Parses an inline `[a, b, c]` array; missing/empty fields become `[]`. */
function toStringArray(value: string | undefined): string[] {
  if (!value) return []
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}
