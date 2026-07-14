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

/** Matches `slugify()`'s own output shape — lowercase alnum segments joined by single dashes. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Shared with `slugify()`/`uniqueSlug()` in `changeLibrary.ts` — both the
 * generator and this validator must agree on the cap, or a slug the
 * generator legitimately produces (e.g. a 64-character base plus a `-2`
 * collision suffix) gets rejected by the very validator meant to accept
 * anything `slugify()` could have produced.
 */
export const MAX_SLUG_LENGTH = 64

/**
 * Reject anything that isn't a slug `slugify()` itself could have produced.
 * `update_change_task`/`archive_change` take a slug straight from the model
 * as a plain string argument, which then gets joined into filesystem paths —
 * unlike every other workspace tool, that join never goes through
 * `resolveInWorkspace()`. A crafted slug like `"..\\..\\outside"` would
 * otherwise resolve outside the workspace, and `archiveChangeMarkdown`'s
 * `rmSync` would recursively delete whatever it points at. The pattern only
 * allows lowercase letters, digits, and single dashes — no `.`, `/`, or `\`
 * is representable at all, so this alone is sufficient; no separate
 * path-confinement check is needed on top of it.
 */
export function assertValidSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug) || slug.length > MAX_SLUG_LENGTH) {
    throw new Error(`"${slug}" is not a valid change slug. Use list_changes to see valid slugs.`)
  }
}

export function changeProposalPath(workspaceRoot: string, slug: string): string {
  assertValidSlug(slug)
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
