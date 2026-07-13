import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillScope } from '@shared/skill.types'
import { projectSkillsDir } from './skillCatalog'
import { parseSkillFile } from './skillFile'

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface SkillLibraryLocation {
  workspaceRoot?: string | null
  personalDir: string
  scope: SkillScope
}

export interface SkillWriteRequest extends SkillLibraryLocation {
  originalName?: string | null
  content: string
}

export interface SkillWriteResult {
  name: string
  scope: SkillScope
}

export function skillFileNameFromSkillName(name: string): string {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}". Use lowercase letters, numbers, dashes, or underscores.`
    )
  }
  return `${name}.md`
}

export function readSkillMarkdown(location: SkillLibraryLocation & { name: string }): string {
  const filePath = skillPathFor(location, location.name)
  return readFileSync(filePath, 'utf-8')
}

export function deleteSkillMarkdown(location: SkillLibraryLocation & { name: string }): void {
  const filePath = skillPathFor(location, location.name)
  if (existsSync(filePath)) rmSync(filePath)
}

export function writeSkillMarkdown(request: SkillWriteRequest): SkillWriteResult {
  const dir = skillDirectoryFor(request)
  mkdirSync(dir, { recursive: true })

  const parsed = parseSkillFile(request.content, '<skill-draft>')
  const originalFileName = request.originalName
    ? skillFileNameFromSkillName(request.originalName)
    : null
  const targetPath = join(dir, skillFileNameFromSkillName(parsed.name))
  writeFileSync(targetPath, request.content, 'utf-8')

  if (request.originalName && request.originalName !== parsed.name) {
    const oldPath = join(dir, originalFileName ?? '')
    if (oldPath !== targetPath && existsSync(oldPath)) rmSync(oldPath)
  }

  return { name: parsed.name, scope: request.scope }
}

function skillPathFor(location: SkillLibraryLocation, name: string): string {
  return join(skillDirectoryFor(location), skillFileNameFromSkillName(name))
}

function skillDirectoryFor(location: SkillLibraryLocation): string {
  if (location.scope === 'personal') return location.personalDir
  if (!location.workspaceRoot)
    throw new Error('Project skills require an active project workspace.')
  return projectSkillsDir(location.workspaceRoot)
}
