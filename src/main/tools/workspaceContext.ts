import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'
import { PROJECT_NOTES_FILENAME } from './projectNotesTool'

/**
 * Builds a small, cached summary of the active workspace that is injected into
 * the system prompt. Giving the model ambient awareness of the project (name,
 * layout, scripts, README) means it starts oriented instead of blind, which
 * makes it far more likely to do what the user asks without floundering.
 *
 * The summary is deliberately tiny (hard character cap) so it doesn't eat the
 * context budget — the model still uses tools to read actual file contents.
 */

const MAX_TREE_ENTRIES = 60
const MAX_CHARS = 2000
const README_LINES = 8
const CACHE_TTL_MS = 30_000
const MAX_ACTIVITY_FILES = 8
const MAX_ACTIVITY_SUMMARIES = 2
/** Tail-sliced, not head — newest notes land at the end of the file, unlike a README. */
const NOTES_CHARS = 800

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  '.cache',
  'build',
  '.turbo'
])

interface CacheEntry {
  root: string
  builtAt: number
  text: string
}

let cache: CacheEntry | null = null

/**
 * Return a cached workspace summary, rebuilding when stale or root changes, plus
 * a short "recent activity" section (files touched, past task summaries) drawn
 * fresh from project memory every call so it never goes stale mid-conversation.
 */
export function buildWorkspaceContext(root: string, projectId: string | null): string {
  if (!cache || cache.root !== root || Date.now() - cache.builtAt >= CACHE_TTL_MS) {
    cache = { root, builtAt: Date.now(), text: build(root) }
  }
  const activity = projectId ? buildActivitySummary(projectId) : ''
  return activity ? `${cache.text}\n\n${activity}` : cache.text
}

/** Summarise recently touched files and past task summaries for this project. */
function buildActivitySummary(projectId: string): string {
  const memory = projectMemoryStore.get(projectId)
  if (memory.filesTouched.length === 0 && memory.recentSummaries.length === 0) return ''

  const lines: string[] = [
    'Recent activity from past conversations in this project. This is background ' +
      'context only — it may be unrelated to the current request. Do not assume the ' +
      "current task is a continuation of any of it, and don't reuse code or fixes " +
      'from it unless they actually apply to what the user is asking now.'
  ]

  const files = memory.filesTouched.slice(0, MAX_ACTIVITY_FILES)
  if (files.length) {
    lines.push('Files touched previously (for orientation only):')
    lines.push(...files.map((touch) => `- ${touch.action}: ${touch.path}`))
  }

  const summaries = memory.recentSummaries.slice(0, MAX_ACTIVITY_SUMMARIES)
  if (summaries.length) {
    lines.push('Summaries of past, possibly-unrelated tasks:')
    lines.push(...summaries.map((entry) => `- ${entry.summary}`))
  }

  return lines.join('\n')
}

function build(root: string): string {
  if (!existsSync(root)) return ''
  const lines: string[] = [`Name: ${basename(root)}`, `Path: ${root}`]

  const pkg = readJson(join(root, 'package.json'))
  if (pkg && typeof pkg === 'object') {
    const record = pkg as Record<string, unknown>
    if (typeof record.name === 'string') lines.push(`package.json name: ${record.name}`)
    if (record.scripts && typeof record.scripts === 'object') {
      const scripts = Object.keys(record.scripts)
      if (scripts.length) lines.push(`Scripts: ${scripts.join(', ')}`)
    }
  }

  const tree = topLevelTree(root)
  if (tree.length) {
    lines.push('Top-level entries:')
    lines.push(tree.join('\n'))
  }

  const readme = readmeExcerpt(root)
  if (readme) {
    lines.push('README (excerpt):')
    lines.push(readme)
  }

  const notes = projectNotesExcerpt(root)
  if (notes) {
    lines.push(
      `Notes Anodex previously recorded about this project (from ${PROJECT_NOTES_FILENAME}, most recent last):`
    )
    lines.push(notes)
  }

  const text = lines.join('\n')
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…` : text
}

/** List top-level entries, folders first, ignoring build/vcs directories. */
function topLevelTree(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => !(entry.isDirectory() && SKIP_DIRS.has(entry.name)))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, MAX_TREE_ENTRIES)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  } catch {
    return []
  }
}

function readmeExcerpt(root: string): string | null {
  for (const name of ['README.md', 'README', 'readme.md', 'Readme.md']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    try {
      return readFileSync(path, 'utf-8').split('\n').slice(0, README_LINES).join('\n').trim()
    } catch {
      return null
    }
  }
  return null
}

/** The tail of `ANODEX.md`, if present — newest notes first via the caller's framing. */
function projectNotesExcerpt(root: string): string | null {
  const path = join(root, PROJECT_NOTES_FILENAME)
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf-8').trim()
    if (!text) return null
    return text.length > NOTES_CHARS ? `…${text.slice(-NOTES_CHARS)}` : text
  } catch {
    return null
  }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}
