const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const COPY_SUFFIX = '-copy'

export function nextSkillCopyName(existingNames: string[], sourceName: string): string {
  const existing = new Set(existingNames)
  const base = copyBaseName(sourceName)
  let candidate = `${base}${COPY_SUFFIX}`
  let counter = 2

  while (existing.has(candidate)) {
    const suffix = `${COPY_SUFFIX}-${counter}`
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`
    counter += 1
  }

  return candidate
}

export function duplicateSkillMarkdown(markdown: string, newName: string): string {
  if (!SKILL_NAME_RE.test(newName)) {
    throw new Error(`Invalid skill name "${newName}".`)
  }
  if (!/^name:\s*[^\r\n]+\s*$/m.test(markdown)) {
    throw new Error('Skill markdown must include a frontmatter name before it can be duplicated.')
  }
  return markdown.replace(/^name:\s*[^\r\n]+\s*$/m, `name: ${newName}`)
}

function copyBaseName(sourceName: string): string {
  const suffixLength = COPY_SUFFIX.length
  const base = sourceName.slice(0, 64 - suffixLength).replace(/[-_]+$/g, '')
  return base || 'skill'
}
