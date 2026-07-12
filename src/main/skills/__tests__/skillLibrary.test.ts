import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectSkillsDir } from '../skillCatalog'
import { readSkillMarkdown, skillFileNameFromSkillName, writeSkillMarkdown } from '../skillLibrary'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anodex-skill-library-'))
}

function validSkill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} workflow.\nkeywords: [${name}]\ntools: []\n---\n# ${name}\nUse this skill.\n`
}

describe('skillFileNameFromSkillName', () => {
  it('maps valid skill names to markdown filenames', () => {
    expect(skillFileNameFromSkillName('code-review')).toBe('code-review.md')
  })

  it('rejects path traversal and invalid names', () => {
    expect(() => skillFileNameFromSkillName('../secret')).toThrow(/Invalid skill name/)
    expect(() => skillFileNameFromSkillName('bad/name')).toThrow(/Invalid skill name/)
    expect(() => skillFileNameFromSkillName('')).toThrow(/Invalid skill name/)
  })
})

describe('readSkillMarkdown', () => {
  it('reads project skill markdown without exposing arbitrary paths', () => {
    const workspaceRoot = makeTempDir()
    const dir = projectSkillsDir(workspaceRoot)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'code-review.md'), validSkill('code-review'), 'utf-8')

    expect(
      readSkillMarkdown({
        workspaceRoot,
        personalDir: makeTempDir(),
        scope: 'project',
        name: 'code-review'
      })
    ).toContain('name: code-review')
  })
})

describe('writeSkillMarkdown', () => {
  it('validates and writes project skill markdown by frontmatter name', () => {
    const workspaceRoot = makeTempDir()
    const personalDir = makeTempDir()

    const result = writeSkillMarkdown({
      workspaceRoot,
      personalDir,
      scope: 'project',
      originalName: null,
      content: validSkill('release-checklist')
    })

    expect(result.name).toBe('release-checklist')
    expect(
      readFileSync(join(projectSkillsDir(workspaceRoot), 'release-checklist.md'), 'utf-8')
    ).toContain('# release-checklist')
  })

  it('removes the old skill file when a skill is renamed', () => {
    const workspaceRoot = makeTempDir()
    const personalDir = makeTempDir()
    const dir = projectSkillsDir(workspaceRoot)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'old-name.md'), validSkill('old-name'), 'utf-8')

    writeSkillMarkdown({
      workspaceRoot,
      personalDir,
      scope: 'project',
      originalName: 'old-name',
      content: validSkill('new-name')
    })

    expect(existsSync(join(dir, 'old-name.md'))).toBe(false)
    expect(existsSync(join(dir, 'new-name.md'))).toBe(true)
  })

  it('rejects markdown whose frontmatter name cannot be used as a file name', () => {
    expect(() =>
      writeSkillMarkdown({
        workspaceRoot: makeTempDir(),
        personalDir: makeTempDir(),
        scope: 'project',
        originalName: null,
        content: validSkill('../secret')
      })
    ).toThrow(/Invalid skill name/)
  })
})
