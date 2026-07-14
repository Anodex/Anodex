import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Change, ChangeTask } from '@shared/change.types'
import { parseChangeFile, serializeChangeFile } from './changeFile'
import { projectChangesDir, changeProposalPath, ARCHIVE_DIR_NAME } from './changeCatalog'

const SPEC_FILENAME = 'SPEC.md'

/** Lowercase-dash slug from a title; appends `-2`, `-3`, ... on collision. */
export function slugify(title: string): string {
  const base =
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'change'
  return base
}

function uniqueSlug(workspaceRoot: string, title: string): string {
  const base = slugify(title)
  let slug = base
  let attempt = 2
  while (existsSync(changeProposalPath(workspaceRoot, slug))) {
    slug = `${base}-${attempt}`
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
  writeFileSync(filePath, serializeChangeFile(parsed), 'utf-8')
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
  writeFileSync(filePath, serializeChangeFile(updated), 'utf-8')
  return { slug, filePath, ...updated }
}

/**
 * Move a change's directory into `archive/<date>-<slug>/` and fold it into
 * the project's living spec (`.anodex/SPEC.md`) — the archive step from the
 * original propose → apply → archive workflow this feature is based on.
 */
export function archiveChangeMarkdown(workspaceRoot: string, slug: string): Change {
  const filePath = changeProposalPath(workspaceRoot, slug)
  if (!existsSync(filePath)) {
    throw new Error(`No change named "${slug}" found. Use list_changes to see active changes.`)
  }
  const parsed = parseChangeFile(readFileSync(filePath, 'utf-8'), filePath)

  const dateStamp = new Date().toISOString().slice(0, 10)
  const archiveDir = join(
    projectChangesDir(workspaceRoot),
    ARCHIVE_DIR_NAME,
    `${dateStamp}-${slug}`
  )
  mkdirSync(archiveDir, { recursive: true })
  const archived = {
    ...parsed,
    status: 'archived' as const,
    updatedAt: new Date().toISOString()
  }
  const archivedFilePath = join(archiveDir, 'proposal.md')
  writeFileSync(archivedFilePath, serializeChangeFile(archived), 'utf-8')

  rmSync(join(projectChangesDir(workspaceRoot), slug), { recursive: true, force: true })
  appendToSpec(workspaceRoot, { title: parsed.title, why: parsed.why, tasks: parsed.tasks })

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
    writeFileSync(
      specPath,
      `# Project spec\n\nA living record of changes made to this project, maintained by Anodex as changes are archived.\n${section}`,
      'utf-8'
    )
  } else {
    appendFileSync(specPath, section, 'utf-8')
  }
}
