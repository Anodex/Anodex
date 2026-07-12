import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSkillCatalog, projectSkillsDir } from '../skillCatalog'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anodex-skills-'))
}

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\nkeywords: [${name}]\ntools: [read_file]\n---\n# ${name}\nUse this skill.\n`,
    'utf-8'
  )
}

describe('skillCatalog', () => {
  it('loads project skills before personal skills and records their scope', () => {
    const workspaceRoot = makeTempDir()
    const personalDir = join(makeTempDir(), 'skills')
    const projectDir = projectSkillsDir(workspaceRoot)
    writeSkill(personalDir, 'personal-review', 'Personal review workflow.')
    writeSkill(projectDir, 'project-review', 'Project review workflow.')

    const skills = listSkillCatalog({ personalDir, workspaceRoot })

    expect(skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual([
      'project:project-review',
      'personal:personal-review'
    ])
  })

  it('lets a project skill override a personal skill with the same name', () => {
    const workspaceRoot = makeTempDir()
    const personalDir = join(makeTempDir(), 'skills')
    const projectDir = projectSkillsDir(workspaceRoot)
    writeSkill(personalDir, 'code-review', 'Personal review workflow.')
    writeSkill(projectDir, 'code-review', 'Project-specific review workflow.')

    const skills = listSkillCatalog({ personalDir, workspaceRoot })

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'code-review',
      description: 'Project-specific review workflow.',
      scope: 'project'
    })
  })

  it('returns personal skills when no workspace is selected', () => {
    const personalDir = join(makeTempDir(), 'skills')
    writeSkill(personalDir, 'handoff-notes', 'Capture handoff notes.')

    const skills = listSkillCatalog({ personalDir, workspaceRoot: null })

    expect(skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual([
      'personal:handoff-notes'
    ])
  })
})
