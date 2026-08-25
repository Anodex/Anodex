import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { FileTouch, ProjectMemory, ProjectRecallEvent } from '@shared/projectMemory.types'
import { wordSet } from '@shared/textSimilarity'
import { referenceContextShare } from '@shared/contextBudget'
import { SKIP_DIRS } from '@shared/skipDirectories'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'
import { codeIndexer } from '../codeIndex/CodeIndexer'
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
const README_LINES = 8
const CACHE_TTL_MS = 30_000
const MAX_ACTIVITY_FILES = 8
const MAX_ACTIVITY_SUMMARIES = 3

/**
 * What each section is worth when the window can afford it. These are the sizes
 * the summary was tuned to be useful at, so they are ceilings rather than
 * targets: there is no more workspace worth describing on a 128k window than on
 * a 32k one.
 */
const FULL_CORE_CHARS = 2000
/** Tail-sliced, not head — newest notes land at the end of the file, unlike a README. */
const FULL_NOTES_CHARS = 800
/** Tail-sliced, same reasoning as `FULL_NOTES_CHARS` — newest archived changes land at the end. */
const FULL_SPEC_CHARS = 800

interface CharBudget {
  core: number
  notes: number
  spec: number
}

/**
 * Scale the three sections to what the context window can afford, keeping their
 * relative sizes.
 *
 * At 8,192 tokens and above the reference budget already exceeds what these
 * sections want, so nothing changes. Below that it bites, and it should: 3,600
 * characters of preamble is roughly a fifth of a 2,048-token window spent
 * before the task has started. Squeezing all three together rather than
 * dropping one keeps the summary's shape — a tree with no notes reads as though
 * the project has none.
 */
function charBudget(contextSize?: number): CharBudget {
  const share = contextSize ? referenceContextShare(contextSize) : 1
  return {
    core: Math.floor(FULL_CORE_CHARS * share),
    notes: Math.floor(FULL_NOTES_CHARS * share),
    spec: Math.floor(FULL_SPEC_CHARS * share)
  }
}

interface CacheEntry {
  root: string
  /** Part of the key: a context-size change must not serve a stale budget. */
  budget: CharBudget
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
  retrievalQuery = '',
  contextSize?: number
): string {
  const { summary, activity } = buildWorkspaceContextParts(
    root,
    projectId,
    retrievalQuery,
    contextSize
  )
  return activity ? `${summary}\n\n${activity}` : summary
}

/**
 * The same summary as two independently droppable pieces.
 *
 * The orientation half (tree, README, scripts) is what a task needs before it
 * can act at all; the activity half is ranked recall from earlier conversations
 * in this project — genuinely useful, but the first thing worth giving up when
 * the window cannot afford everything. Splitting them here means the shared
 * automatic-reference packer can drop one whole piece instead of slicing
 * through the middle of a file tree. See `AutomaticReferenceSource` in
 * `contextPlanner.ts`.
 */
export function buildWorkspaceContextParts(
  root: string,
  projectId: string | null,
  retrievalQuery = '',
  contextSize?: number
): { summary: string; activity: string } {
  const budget = charBudget(contextSize)
  // Inline rather than hoisted to a `stale` flag: the null check has to stay in
  // the condition for the compiler to know `cache` is populated afterwards.
  if (
    !cache ||
    cache.root !== root ||
    cache.budget.core !== budget.core ||
    Date.now() - cache.builtAt >= CACHE_TTL_MS
  ) {
    cache = { root, budget, builtAt: Date.now(), text: build(root, budget) }
  }
  // Fire-and-forget: keeps the semantic code index (see `search_code`) fresh
  // in the background, throttled/single-flighted internally by the indexer
  // itself. Never awaited — this turn's response must not wait on a
  // potentially-slow full workspace walk; whatever's fresh by the time a
  // later search_code call runs is what benefits. No-op without a project,
  // same scoping as project memory below, since the index is persisted
  // per-project.
  if (projectId) codeIndexer.ensureFresh(projectId, root)
  return {
    summary: cache.text,
    activity: projectId ? buildActivitySummary(projectId, retrievalQuery) : ''
  }
}

/**
 * Retrieve relevant touched files and past recall events for this project.
 * Only genuine lexical matches are injected — no "nothing matched, show
 * recent activity anyway" fallback — since that shape of fallback is exactly
 * what caused this project's earlier documented project-memory-bleed bug
 * (unrelated past activity leaking into and biasing an unrelated new task).
 */
function buildActivitySummary(projectId: string, retrievalQuery: string): string {
  const memory = projectMemoryStore.get(projectId)
  if (memory.filesTouched.length === 0 && memory.recentEvents.length === 0) return ''

  const files = rankTouchedFiles(memory, retrievalQuery).slice(0, MAX_ACTIVITY_FILES)
  const events = rankRecallEvents(memory, retrievalQuery).slice(0, MAX_ACTIVITY_SUMMARIES)
  if (files.length === 0 && events.length === 0) return ''

  const lines: string[] = [
    'Retrieved project recall from past conversations. This is background context only, ' +
      'ranked by lexical overlap with the current request — not a guarantee of relevance. ' +
      "Don't reuse code or fixes from it unless they actually apply to what the user is " +
      'asking now; ignore anything that does not.'
  ]

  if (files.length) {
    lines.push('Potentially relevant files touched previously:')
    lines.push(...files.map((touch) => `- ${touch.action}: ${touch.path}`))
  }

  if (events.length) {
    lines.push(
      'Potentially relevant past turns. changedFiles/verification below are confirmed from real ' +
        'tool results; anything marked "assistant\'s own account" is only the model\'s own ' +
        'unverified claim about what it did, not a confirmed outcome:'
    )
    lines.push(...events.map(formatRecallEvent))
  }

  return lines.join('\n')
}

/** One compact line per event, verified facts first, unverified prose clearly labeled. */
function formatRecallEvent(event: ProjectRecallEvent): string {
  const verified: string[] = []
  if (event.changedFiles.length) verified.push(`changed ${event.changedFiles.join(', ')}`)
  for (const v of event.verification) verified.push(`ran \`${v.command}\` (${v.status})`)
  if (event.failedTools.length) verified.push(`${event.failedTools.join(', ')} failed`)

  const line = verified.length ? verified.join('; ') : 'no verified file changes or commands'
  const supplemental = event.assistantSummary
    ? ` — assistant's own account (unverified): ${event.assistantSummary}`
    : ''
  return `- ${line}${supplemental}`
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
  return onlyRelevantMatches(ranked)
}

/** Exported for unit tests; ranks recall events by lexical relevance, then recency. */
export function rankRecallEvents(
  memory: ProjectMemory,
  retrievalQuery: string
): ProjectRecallEvent[] {
  const queryWords = wordSet(retrievalQuery)
  const ranked = [...memory.recentEvents]
    .map((entry) => ({ entry, relevance: overlapScore(recallEventSearchText(entry), queryWords) }))
    .sort((a, b) => {
      if (a.relevance !== b.relevance) return b.relevance - a.relevance
      return b.entry.createdAt - a.entry.createdAt
    })
  return onlyRelevantMatches(ranked)
}

/** Text an event is scored against: what changed, what ran, and its supplemental summary. */
function recallEventSearchText(event: ProjectRecallEvent): string {
  return [
    ...event.changedFiles,
    ...event.verification.map((v) => v.command),
    ...event.successfulTools,
    ...event.failedTools,
    event.assistantSummary ?? ''
  ].join(' ')
}

/** No fallback: an item with zero lexical overlap is dropped, not injected anyway. */
function onlyRelevantMatches<T>(items: Array<{ entry: T; relevance: number }>): T[] {
  return items.filter((item) => item.relevance > 0).map((item) => item.entry)
}

function overlapScore(text: string, queryWords: Set<string>): number {
  if (queryWords.size === 0) return 0
  let score = 0
  for (const word of wordSet(text)) {
    if (queryWords.has(word)) score++
  }
  return score
}
function build(root: string, budget: CharBudget): string {
  if (!existsSync(root)) return ''
  const coreLines: string[] = [`Name: ${basename(root)}`, `Path: ${root}`]

  const pkg = readJson(join(root, 'package.json'))
  if (pkg && typeof pkg === 'object') {
    const record = pkg as Record<string, unknown>
    if (typeof record.name === 'string') coreLines.push(`package.json name: ${record.name}`)
    if (record.scripts && typeof record.scripts === 'object') {
      const scripts = Object.keys(record.scripts)
      if (scripts.length) coreLines.push(`Scripts: ${scripts.join(', ')}`)
    }
  }

  const tree = topLevelTree(root)
  if (tree.length) {
    coreLines.push('Top-level entries:')
    coreLines.push(tree.join('\n'))
  }

  const readme = readmeExcerpt(root)
  if (readme) {
    coreLines.push('README (excerpt):')
    coreLines.push(readme)
  }

  // Notes and SPEC.md are built separately from the core section (name, tree,
  // README, ...). They used to be subtracted from the core's allowance, because
  // a single constant covered all three and a long README could otherwise fill
  // it and silently evict SPEC.md. Each section now carries its own cap, which
  // solves that by construction — and subtracting as well would charge the core
  // twice, which on a small window truncated the project's own name mid-word.
  const trailingLines: string[] = []
  const notes = projectNotesExcerpt(root, budget.notes)
  if (notes) {
    trailingLines.push(
      `Notes Anodex previously recorded about this project (from ${PROJECT_NOTES_FILENAME}, most recent last):`,
      notes
    )
  }
  const spec = specExcerpt(root, budget.spec)
  if (spec) {
    trailingLines.push(
      "This project's living spec (from .anodex/SPEC.md, built from archived change proposals, most recent last):",
      spec
    )
  }
  const trailingText = trailingLines.length ? `\n${trailingLines.join('\n')}` : ''

  const coreText = coreLines.join('\n')
  const coreBudget = budget.core
  const truncatedCore =
    coreText.length > coreBudget ? `${coreText.slice(0, coreBudget)}\n…` : coreText

  return `${truncatedCore}${trailingText}`
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
function projectNotesExcerpt(root: string, limit: number): string | null {
  const path = join(root, PROJECT_NOTES_FILENAME)
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf-8').trim()
    if (!text) return null
    return text.length > limit ? `…${text.slice(-limit)}` : text
  } catch {
    return null
  }
}

/** The tail of `.anodex/SPEC.md`, if present — newest archived changes first via the caller's framing. */
function specExcerpt(root: string, limit: number): string | null {
  const path = join(root, '.anodex', 'SPEC.md')
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf-8').trim()
    if (!text) return null
    return text.length > limit ? `…${text.slice(-limit)}` : text
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
