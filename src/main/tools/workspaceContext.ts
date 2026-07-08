import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { FileTouch, ProjectMemory, TaskSummary } from '@shared/projectMemory.types'
import { wordSet } from '../memory/textSimilarity'
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
const MAX_ACTIVITY_SUMMARIES = 3
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
 * a short retrieval-ranked project recall section drawn fresh from project
 * memory every call so it never goes stale mid-conversation.
 */
export function buildWorkspaceContext(
  root: string,
  projectId: string | null,
  retrievalQuery = ''
): string {
  if (!cache || cache.root !== root || Date.now() - cache.builtAt >= CACHE_TTL_MS) {
    cache = { root, builtAt: Date.now(), text: build(root) }
  }
  const activity = projectId ? buildActivitySummary(projectId, retrievalQuery) : ''
  return activity ? `${cache.text}\n\n${activity}` : cache.text
}

/** Retrieve relevant touched files and past task summaries for this project. */
function buildActivitySummary(projectId: string, retrievalQuery: string): string {
  const memory = projectMemoryStore.get(projectId)
  if (memory.filesTouched.length === 0 && memory.recentSummaries.length === 0) return ''

  const lines: string[] = [
    'Retrieved project recall from past conversations. This is background context only. ' +
      'Use it when it is relevant to the current request; ignore it when it is not.'
  ]

  const files = rankTouchedFiles(memory, retrievalQuery).slice(0, MAX_ACTIVITY_FILES)
  if (files.length) {
    lines.push('Potentially relevant files touched previously:')
    lines.push(...files.map((touch) => `- ${touch.action}: ${touch.path}`))
  }

  const summaries = rankTaskSummaries(memory, retrievalQuery).slice(0, MAX_ACTIVITY_SUMMARIES)
  if (summaries.length) {
    lines.push('Potentially relevant past task summaries:')
    lines.push(...summaries.map((entry) => `- ${entry.summary}`))
  }

  return lines.join('\n')
}

/** Exported for unit tests; ranks by lexical relevance, then recency. */
export function rankTouchedFiles(memory: ProjectMemory, retrievalQuery: string): FileTouch[] {
  const queryWords = wordSet(retrievalQuery)
  const ranked = [...memory.filesTouched]
    .map((entry) => ({ entry, relevance: overlapScore(entry.path, queryWords) }))
    .sort((a, b) => {
      if (a.relevance !== b.relevance) return b.relevance - a.relevance
      return b.entry.at - a.entry.at
    })
  return onlyRelevantWhenAvailable(ranked)
}

/** Exported for unit tests; ranks summaries by lexical relevance, then recency. */
export function rankTaskSummaries(memory: ProjectMemory, retrievalQuery: string): TaskSummary[] {
  const queryWords = wordSet(retrievalQuery)
  const ranked = [...memory.recentSummaries]
    .map((entry) => ({ entry, relevance: overlapScore(entry.summary, queryWords) }))
    .sort((a, b) => {
      if (a.relevance !== b.relevance) return b.relevance - a.relevance
      return b.entry.at - a.entry.at
    })
  return onlyRelevantWhenAvailable(ranked)
}

function onlyRelevantWhenAvailable<T>(items: Array<{ entry: T; relevance: number }>): T[] {
  if (items.some((item) => item.relevance > 0)) {
    return items.filter((item) => item.relevance > 0).map((item) => item.entry)
  }
  return items.map((item) => item.entry)
}

function overlapScore(text: string, queryWords: Set<string>): number {
  if (queryWords.size === 0) return 0
  let score = 0
  for (const word of wordSet(text)) {
    if (queryWords.has(word)) score++
  }
  return score
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
