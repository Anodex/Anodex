import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Change } from '@shared/change.types'
import { parseChangeFile } from './changeFile'
import { createLogger } from '../utils/logger'

const log = createLogger('change-catalog')

/** Archived changes live under this subdirectory — excluded from the active list. */
export const ARCHIVE_DIR_NAME = 'archive'

export function projectChangesDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.anodex', 'changes')
}

export function changeProposalPath(workspaceRoot: string, slug: string): string {
  return join(projectChangesDir(workspaceRoot), slug, 'proposal.md')
}

/** List active (non-archived) changes for a project workspace, newest first. */
export function listChanges(workspaceRoot: string): Change[] {
  const dir = projectChangesDir(workspaceRoot)
  if (!existsSync(dir)) return []

  let slugs: string[]
  try {
    slugs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== ARCHIVE_DIR_NAME)
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    log.warn(`Failed to read changes directory "${dir}":`, error)
    return []
  }

  const changes: Change[] = []
  for (const slug of slugs) {
    const filePath = join(dir, slug, 'proposal.md')
    if (!existsSync(filePath)) continue
    try {
      const raw = readFileSync(filePath, 'utf-8')
      changes.push({ slug, filePath, ...parseChangeFile(raw, filePath) })
    } catch (error) {
      log.warn(`Skipping invalid change file "${filePath}":`, error)
    }
  }
  return changes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
