import type { MemoryEntry } from '@shared/memory.types'
import { memoryStore } from './MemoryStore'
import { wordSet } from './textSimilarity'

/**
 * Builds the `# Memory` prompt section from stored entries. Deliberately not
 * semantic/embedding-based — at the scale this store realistically holds
 * (dozens of entries, not thousands), a cheap filter is enough: pinned first,
 * then identity facts, then whatever shares words with the current prompt,
 * then most recent. Capped hard so a growing memory store can never dominate
 * the system prompt.
 */

const MAX_ENTRIES = 8
const MAX_CHARS = 1500

export interface MemoryRetrievalOptions {
  crossChatEnabled: boolean
  personalEnabled: boolean
}

/** The formatted `# Memory` section text, plus which entries actually made it in (for UI visibility). */
export interface MemoryRetrievalResult {
  text: string
  entries: MemoryEntry[]
}

export function buildMemoryContext(
  projectId: string | null,
  userPrompt: string,
  options: MemoryRetrievalOptions
): MemoryRetrievalResult | null {
  const entries = gatherEntries(projectId, options)
  if (entries.length === 0) return null

  const ranked = scoreEntries(entries, userPrompt).slice(0, MAX_ENTRIES)
  if (ranked.length === 0) return null

  const lines: string[] = []
  const used: MemoryEntry[] = []
  let usedChars = 0
  for (const entry of ranked) {
    const line = `- [${entry.kind}] ${entry.text} (${scopeLabel(entry)})`
    if (usedChars + line.length > MAX_CHARS && lines.length > 0) break
    lines.push(line)
    used.push(entry)
    usedChars += line.length
  }

  return lines.length ? { text: lines.join('\n'), entries: used } : null
}

function gatherEntries(projectId: string | null, options: MemoryRetrievalOptions): MemoryEntry[] {
  const project =
    options.crossChatEnabled && projectId
      ? memoryStore.list({ type: 'project', projectId })
      : []
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

function scopeLabel(entry: MemoryEntry): string {
  return entry.scope.type === 'global' ? 'global' : 'project'
}
