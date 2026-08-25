import type { MemoryEntry } from '@shared/memory.types'
import { referenceContextShare } from '@shared/contextBudget'
import { wordSet } from '@shared/textSimilarity'
import { memoryStore } from './MemoryStore'

/**
 * Builds the `# Memory` prompt section from stored entries. Deliberately not
 * semantic/embedding-based — at the scale this store realistically holds
 * (dozens of entries, not thousands), a cheap filter is enough: pinned first,
 * then identity facts, then whatever shares words with the current prompt,
 * then most recent. Capped hard so a growing memory store can never dominate
 * the system prompt.
 */

const MAX_ENTRIES = 8
/**
 * What the memory section is worth when the window can afford it. Scaled by
 * `referenceContextShare` against the same allowance the workspace summary
 * draws on — see `FULL_REFERENCE_CONTEXT_CHARS`.
 */
const FULL_MAX_CHARS = 1500

export interface MemoryRetrievalOptions {
  crossChatEnabled: boolean
  personalEnabled: boolean
}

/** The formatted `# Memory` section text, plus which entries actually made it in (for UI visibility). */
export interface MemoryRetrievalResult {
  text: string
  entries: MemoryEntry[]
  /**
   * One rendered line per entry in `entries`, same order and same length.
   *
   * The shared automatic-reference packer treats a memory entry as indivisible
   * and drops whole ones when the window cannot afford them all, so it needs the
   * lines separately rather than pre-joined — and the 1:1 pairing is what lets
   * the caller report exactly the entries the model was given. See
   * `AutomaticReferenceSource` in `contextPlanner.ts`.
   */
  lines: string[]
}

export function buildMemoryContext(
  projectId: string | null,
  userPrompt: string,
  options: MemoryRetrievalOptions,
  contextSize?: number
): MemoryRetrievalResult | null {
  const maxChars = Math.floor(
    FULL_MAX_CHARS * (contextSize ? referenceContextShare(contextSize) : 1)
  )
  const entries = gatherEntries(projectId, options)
  if (entries.length === 0) return null

  const promptWords = wordSet(userPrompt)
  const ranked = scoreEntries(entries, userPrompt)
    .filter((entry) => shouldRetrieve(entry, promptWords))
    .slice(0, MAX_ENTRIES)
  if (ranked.length === 0) return null

  const lines: string[] = []
  const used: MemoryEntry[] = []
  let usedChars = 0
  for (const entry of ranked) {
    const line = `- [${entry.kind}] ${entry.text} (${scopeLabel(entry)})`
    const remaining = maxChars - usedChars
    if (line.length > remaining) {
      if (lines.length === 0) {
        lines.push(`${line.slice(0, Math.max(0, maxChars - 1))}…`)
        used.push(entry)
      }
      break
    }
    lines.push(line)
    used.push(entry)
    usedChars += line.length
  }

  return lines.length ? { text: lines.join('\n'), entries: used, lines } : null
}

function gatherEntries(projectId: string | null, options: MemoryRetrievalOptions): MemoryEntry[] {
  const project =
    options.crossChatEnabled && projectId ? memoryStore.list({ type: 'project', projectId }) : []
  const global = options.personalEnabled ? memoryStore.list({ type: 'global' }) : []
  return [...project, ...global]
}

/**
 * Rank entries: pinned first (stable), then identity facts (who the user is —
 * these rarely share words with how someone asks about their own identity),
 * then by lexical overlap with the current prompt, then most-recently-updated.
 * Exported for unit testing without touching disk.
 */
export function scoreEntries(entries: MemoryEntry[], userPrompt: string): MemoryEntry[] {
  const promptWords = wordSet(userPrompt)
  return [...entries]
    .map((entry) => ({ entry, overlap: overlapScore(entry.text, promptWords) }))
    .sort((a, b) => {
      if (a.entry.pinned !== b.entry.pinned) return a.entry.pinned ? -1 : 1
      const aIdentity = a.entry.kind === 'identity'
      const bIdentity = b.entry.kind === 'identity'
      if (aIdentity !== bIdentity) return aIdentity ? -1 : 1
      if (a.overlap !== b.overlap) return b.overlap - a.overlap
      return b.entry.updatedAt - a.entry.updatedAt
    })
    .map((ranked) => ranked.entry)
}

function overlapScore(text: string, promptWords: Set<string>): number {
  if (promptWords.size === 0) return 0
  let score = 0
  for (const word of wordSet(text)) {
    if (promptWords.has(word)) score++
  }
  return score
}

function shouldRetrieve(entry: MemoryEntry, promptWords: Set<string>): boolean {
  if (entry.pinned || entry.kind === 'identity') return true
  return overlapScore(entry.text, promptWords) > 0
}

function scopeLabel(entry: MemoryEntry): string {
  return entry.scope.type === 'global' ? 'global' : 'project'
}
