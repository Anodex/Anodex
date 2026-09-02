import { existsSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { writeTextAtomic } from '../utils/atomicWrite'
import { join } from 'node:path'
import type { Change, ChangeTask } from '@shared/change.types'
import { parseChangeFile, serializeChangeFile } from './changeFile'
import {
  projectChangesDir,
  changeProposalPath,
  ARCHIVE_DIR_NAME,
  MAX_SLUG_LENGTH
} from './changeCatalog'

const SPEC_FILENAME = 'SPEC.md'

/**
 * Lowercase-dash slug from a title; appends `-2`, `-3`, ... on collision (see
 * `uniqueSlug` below). Trims trailing dashes both before *and* after the
 * length cap — trimming only before it can't catch a dash that the cap
 * itself lands on (e.g. a 63-char run of one word followed by a separator:
 * the untruncated string has no trailing dash to trim, but slicing to 64
 * chars cuts right after that separator and produces one). Left untrimmed,
 * that slug would fail `assertValidSlug()` in `changeCatalog.ts`, which only
 * accepts slugs `slugify()` itself could produce — this function is exactly
 * what's supposed to produce them.
 */
export function slugify(title: string): string {
  const base =
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SLUG_LENGTH)
      .replace(/-+$/g, '') || 'change'
  return base
}

/**
 * Appends `-2`, `-3`, ... on collision, reserving room for the suffix so the
 * result never exceeds `MAX_SLUG_LENGTH` — a naive `${base}-${attempt}` can
 * overflow the cap when `base` is already at (or near) the limit, which
 * would make `changeProposalPath()` below reject a slug this function was
 * specifically trying to make unique, turning an ordinary title collision
 * into a hard failure instead of an "-2" suffix.
 */
function uniqueSlug(workspaceRoot: string, title: string): string {
  const base = slugify(title)
  let slug = base
  let attempt = 2
  while (existsSync(changeProposalPath(workspaceRoot, slug))) {
    const suffix = `-${attempt}`
    const trimmedBase =
      base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, '') || 'change'
    slug = `${trimmedBase}${suffix}`
    attempt++
  }
  return slug
}

export function createChangeMarkdown(
  workspaceRoot: string,
  title: string,
  why: string,
  taskTitles: string[]
): Change {
  const slug = uniqueSlug(workspaceRoot, title)
  const now = new Date().toISOString()
  const tasks: ChangeTask[] = taskTitles.map((taskTitle) => ({ title: taskTitle, done: false }))
  const filePath = changeProposalPath(workspaceRoot, slug)
  mkdirSync(join(projectChangesDir(workspaceRoot), slug), { recursive: true })
  const parsed = { title, status: 'proposed' as const, why, tasks, createdAt: now, updatedAt: now }
  writeTextAtomic(filePath, serializeChangeFile(parsed))
  return { slug, filePath, ...parsed }
}

export function updateChangeTaskMarkdown(
  workspaceRoot: string,
  slug: string,
  taskIndex: number,
  done: boolean
): Change {
  const filePath = changeProposalPath(workspaceRoot, slug)
  if (!existsSync(filePath)) {
    throw new Error(`No change named "${slug}" found. Use list_changes to see active changes.`)
  }
  const parsed = parseChangeFile(readFileSync(filePath, 'utf-8'), filePath)
  const task = parsed.tasks[taskIndex]
  if (!task) {
    throw new Error(
      `Change "${slug}" has no task at position ${taskIndex + 1} (it has ${parsed.tasks.length}).`
    )
  }
  task.done = done
  const anyDone = parsed.tasks.some((t) => t.done)
  const allDone = parsed.tasks.length > 0 && parsed.tasks.every((t) => t.done)
  const status = allDone ? 'done' : anyDone ? 'in_progress' : 'proposed'
  const updated = { ...parsed, status, updatedAt: new Date().toISOString() } as const
  writeTextAtomic(filePath, serializeChangeFile(updated))
  return { slug, filePath, ...updated }
}

/**
 * `archive/<date>-<slug>/`, disambiguated with a `-2`, `-3`, ... suffix on
 * collision — same reasoning as `uniqueSlug()` above. Two *different* active
 * changes can end up with the same slug over time (a slug only has to be
 * unique among currently-active changes — see `uniqueSlug`'s own existence
 * check — so once the first "add-dark-mode" is archived and removed from the
 * active directory, a later, unrelated change can legitimately reuse that
 * same slug). Without disambiguation, archiving a second change with a
 * reused slug on the same calendar day would silently overwrite the first
 * change's archived record, since `mkdirSync(..., { recursive: true })`
 * doesn't complain about an existing directory.
 */
function uniqueArchiveDir(workspaceRoot: string, dateStamp: string, slug: string): string {
  const base = `${dateStamp}-${slug}`
  let name = base
  let attempt = 2
  while (existsSync(join(projectChangesDir(workspaceRoot), ARCHIVE_DIR_NAME, name))) {
    name = `${base}-${attempt}`
    attempt++
  }
  return join(projectChangesDir(workspaceRoot), ARCHIVE_DIR_NAME, name)
}

/**
 * Move a change's directory into `archive/<date>-<slug>/` and fold it into
 * the project's living spec (`.anodex/SPEC.md`) — the archive step from the
 * original propose → apply → archive workflow this feature is based on.
 *
 * Ordered so that a failure partway through never loses the change entirely:
 * the archived copy is written and folded into SPEC.md *before* the active
 * directory is removed. If either of those earlier steps throws, the change
 * is untouched and still active — visible in `list_changes`, safe to retry —
 * rather than the active copy having already been deleted with no record of
 * it ever having reached the spec.
 */
export function archiveChangeMarkdown(workspaceRoot: string, slug: string): Change {
  const filePath = changeProposalPath(workspaceRoot, slug)
  if (!existsSync(filePath)) {
    throw new Error(`No change named "${slug}" found. Use list_changes to see active changes.`)
  }
  const parsed = parseChangeFile(readFileSync(filePath, 'utf-8'), filePath)

  const dateStamp = new Date().toISOString().slice(0, 10)
  const archiveDir = uniqueArchiveDir(workspaceRoot, dateStamp, slug)
  mkdirSync(archiveDir, { recursive: true })
  const archived = {
    ...parsed,
    status: 'archived' as const,
    updatedAt: new Date().toISOString()
  }
  const archivedFilePath = join(archiveDir, 'proposal.md')
  // Atomic because the original is removed immediately below: a truncated
  // archive plus a deleted source loses the proposal outright.
  writeTextAtomic(archivedFilePath, serializeChangeFile(archived))

  appendToSpec(workspaceRoot, { title: parsed.title, why: parsed.why, tasks: parsed.tasks })
  rmSync(join(projectChangesDir(workspaceRoot), slug), { recursive: true, force: true })

  return { slug, filePath: archivedFilePath, ...archived }
}

/**
 * Append a completed change's summary to the project's living spec, creating
 * it on first use. Plain append, no merge/conflict handling — a single-user
 * local app never has concurrent writers.
 */
function appendToSpec(
  workspaceRoot: string,
  change: { title: string; why: string; tasks: ChangeTask[] }
): void {
  const anodexDir = join(workspaceRoot, '.anodex')
  mkdirSync(anodexDir, { recursive: true })
  const specPath = join(anodexDir, SPEC_FILENAME)
  const taskLines = change.tasks.map((task) => `- ${task.title}`).join('\n')
  const section = `\n## ${change.title}\n\n${change.why}\n\n${taskLines}\n`

  if (!existsSync(specPath)) {
    writeTextAtomic(
      specPath,
      `# Project spec\n\nA living record of changes made to this project, maintained by Anodex as changes are archived.\n${section}`
    )
  } else {
    appendFileSync(specPath, section, 'utf-8')
  }
}
