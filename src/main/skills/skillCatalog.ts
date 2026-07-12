import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Skill, SkillScope } from '@shared/skill.types'
import { parseSkillFile } from './skillFile'
import { createLogger } from '../utils/logger'

const log = createLogger('skill-catalog')

export interface SkillCatalogOptions {
  personalDir: string
  workspaceRoot?: string | null
}

interface SkillDirectory {
  dir: string
  scope: SkillScope
}

export function projectSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.anodex', 'skills')
}

/**
 * Read the active skill catalog from project and personal directories.
 * Project skills come first and override same-named personal skills so a repo can
 * pin its own workflow without mutating the user's global library.
 */
export function listSkillCatalog(options: SkillCatalogOptions): Skill[] {
  const directories: SkillDirectory[] = []
  if (options.workspaceRoot)
    directories.push({ dir: projectSkillsDir(options.workspaceRoot), scope: 'project' })
  directories.push({ dir: options.personalDir, scope: 'personal' })

  const seen = new Set<string>()
  const skills: Skill[] = []
  for (const directory of directories) {
    for (const skill of readSkillDirectory(directory)) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      skills.push(skill)
    }
  }
  return skills
}

function readSkillDirectory(directory: SkillDirectory): Skill[] {
  if (!existsSync(directory.dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(directory.dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
  } catch (error) {
    log.warn(`Failed to read ${directory.scope} skills directory "${directory.dir}":`, error)
    return []
  }

  const skills: Skill[] = []
  for (const entry of entries) {
    const filePath = join(directory.dir, entry)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      skills.push({ ...parseSkillFile(raw, filePath), scope: directory.scope })
    } catch (error) {
      log.warn(`Skipping invalid ${directory.scope} skill file "${filePath}":`, error)
    }
  }
  return skills
}
